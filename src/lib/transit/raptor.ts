/**
 * RAPTOR (Round-based Public Transit Optimized Router).
 *
 * Reference: Delling, Pajor & Werneck, "Round-Based Public Transit Routing"
 * (Transportation Science 2015). We implement the basic one-to-all variant:
 * given an origin point, departure time, and a round cap, compute the
 * earliest arrival time at every reachable stop.
 *
 * --------------------------------------------------------------------------
 * DATA MODEL
 * --------------------------------------------------------------------------
 * GTFS "routes" aren't what RAPTOR means by a route. RAPTOR needs groups of
 * trips that visit exactly the same sequence of stops — we call these
 * "patterns". A single GTFS route (e.g. the 6 train) produces multiple
 * patterns (local vs express vs short-turn variants).
 *
 * Built once per worker boot from IDB:
 *   - `stops`         Map<stopId, TransitStop>
 *   - `patterns`      Map<patternId, Pattern>
 *   - `stopPatterns`  Map<stopId, Array<{ patternId, stopIdxInPattern }>>
 *   - `transfers`     Map<fromStopId, Array<{ toStopId, seconds }>>
 *   - `services`      Map<serviceId, TransitService>
 *
 * --------------------------------------------------------------------------
 * QUERY ALGORITHM
 * --------------------------------------------------------------------------
 *   label[stop] = earliest known arrival time at `stop` (seconds since query
 *                 day midnight). Infinity if unreached.
 *
 *   Round 0: init label[s] for every s within walking range of origin.
 *   Round k = 1..maxRounds:
 *     marked = stops whose label improved in round k-1
 *     1. For each pattern touching a marked stop:
 *        find earliest boardable trip using label[boarding_stop]
 *        traverse pattern, update labels at downstream stops
 *     2. Apply footpath relaxation from newly-improved stops
 *     Stop early if no new improvements.
 *
 * --------------------------------------------------------------------------
 * TIME MODEL
 * --------------------------------------------------------------------------
 * All times are represented as "seconds since midnight of the query date".
 * GTFS trips >=24:00:00 represent overnight service; we pass them through
 * unchanged so a trip departing at "25:30:00" is 5400s past midnight of the
 * next day. This works naturally because we only compare/add seconds.
 */

import { haversineMeters } from "@/lib/transit/auto-transfers";
import {
    getAllServices,
    getAllStops,
    getAllStopTimes,
    getAllTransfers,
    getAllTrips,
    listSystems,
} from "@/lib/transit/gtfs-store";
import type {
    ReachabilityQuery,
    ReachabilityResult,
    TransitService,
    TransitStop,
    TransitTrip,
    TransitTripStopTimes,
} from "@/lib/transit/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ROUNDS = 6;
const SECONDS_PER_MINUTE = 60;
const METERS_PER_MILE = 1609.344;

/** A "pattern" = trips that visit the same stop sequence in the same order. */
interface Pattern {
    id: string;
    /** Ordered list of prefixed stop IDs. */
    stopIds: string[];
    /** Trips on this pattern, each with arrival/departure arrays parallel to stopIds. */
    trips: PatternTrip[];
    /** Sorted by trips[i].departures[0] for binary search of earliest next trip. */
    tripIdxByDeparture: number[];
}

interface PatternTrip {
    tripId: string;
    serviceId: string;
    arrivals: number[]; // seconds since midnight, per stop in pattern
    departures: number[];
}

export interface RaptorData {
    stops: Map<string, TransitStop>;
    patterns: Map<string, Pattern>;
    /** stopId -> list of {patternId, stopIdxInPattern} where the stop appears. */
    stopPatterns: Map<
        string,
        Array<{ patternId: string; idxInPattern: number }>
    >;
    transfers: Map<string, Array<{ toStopId: string; seconds: number }>>;
    services: Map<string, TransitService>;
}

// ---------------------------------------------------------------------------
// Data loading (run once per worker; cache in worker globals)
// ---------------------------------------------------------------------------

export async function loadRaptorData(): Promise<RaptorData> {
    const [systems, stops, trips, stopTimes, services, transfers] =
        await Promise.all([
            listSystems(),
            getAllStops(),
            getAllTrips(),
            getAllStopTimes(),
            getAllServices(),
            getAllTransfers(),
        ]);

    void systems; // kept for parity with UI; unused here

    // --- Build stop map ---
    const stopMap = new Map<string, TransitStop>();
    for (const s of stops) stopMap.set(s.id, s);

    // --- Group trips into patterns (by stop-sequence signature) ---
    const tripById = new Map<string, TransitTrip>();
    for (const t of trips) tripById.set(t.id, t);

    const stopTimesByTrip = new Map<string, TransitTripStopTimes>();
    for (const st of stopTimes) stopTimesByTrip.set(st.tripId, st);

    // patternId = hash of stop sequence. We keep a reverse map while building.
    const patternBySig = new Map<string, Pattern>();

    for (const trip of trips) {
        const st = stopTimesByTrip.get(trip.id);
        if (!st || st.stopIds.length < 2) continue; // skip degenerate trips

        const sig = st.stopIds.join("|");
        let pattern = patternBySig.get(sig);
        if (!pattern) {
            pattern = {
                id: `p:${patternBySig.size}`,
                stopIds: st.stopIds.slice(),
                trips: [],
                tripIdxByDeparture: [],
            };
            patternBySig.set(sig, pattern);
        }
        pattern.trips.push({
            tripId: trip.id,
            serviceId: trip.serviceId,
            arrivals: st.arrivals,
            departures: st.departures,
        });
    }

    // Sort each pattern's trips by departure time at its first stop.
    const patterns = new Map<string, Pattern>();
    for (const p of patternBySig.values()) {
        const order = p.trips
            .map((_, i) => i)
            .sort(
                (a, b) => p.trips[a].departures[0] - p.trips[b].departures[0],
            );
        const sortedTrips: PatternTrip[] = order.map((i) => p.trips[i]);
        p.trips = sortedTrips;
        p.tripIdxByDeparture = sortedTrips.map((t) => t.departures[0]);
        patterns.set(p.id, p);
    }

    // --- Build stopPatterns reverse index ---
    const stopPatterns = new Map<
        string,
        Array<{ patternId: string; idxInPattern: number }>
    >();
    for (const p of patterns.values()) {
        for (let i = 0; i < p.stopIds.length; i++) {
            const arr = stopPatterns.get(p.stopIds[i]);
            if (arr) arr.push({ patternId: p.id, idxInPattern: i });
            else
                stopPatterns.set(p.stopIds[i], [
                    { patternId: p.id, idxInPattern: i },
                ]);
        }
    }

    // --- Build transfers adjacency list ---
    const transferMap = new Map<
        string,
        Array<{ toStopId: string; seconds: number }>
    >();
    for (const t of transfers) {
        const arr = transferMap.get(t.fromStopId);
        if (arr) arr.push({ toStopId: t.toStopId, seconds: t.seconds });
        else
            transferMap.set(t.fromStopId, [
                { toStopId: t.toStopId, seconds: t.seconds },
            ]);
    }

    // Also add zero-cost transfers between platforms that share a parent
    // station. This lets RAPTOR "change platforms" within a station without
    // requiring GTFS transfers.txt to enumerate them. The cost is 0s because
    // it's already modeled as boarding/alighting at the same physical place.
    const parentGroups = new Map<string, string[]>();
    for (const s of stops) {
        if (s.parentStopId) {
            const g = parentGroups.get(s.parentStopId);
            if (g) g.push(s.id);
            else parentGroups.set(s.parentStopId, [s.id]);
        }
    }
    for (const group of parentGroups.values()) {
        if (group.length < 2) continue;
        for (const from of group) {
            for (const to of group) {
                if (from === to) continue;
                const arr = transferMap.get(from);
                if (arr) {
                    // Don't duplicate if GTFS already supplied a transfer.
                    if (!arr.some((e) => e.toStopId === to)) {
                        arr.push({ toStopId: to, seconds: 0 });
                    }
                } else {
                    transferMap.set(from, [{ toStopId: to, seconds: 0 }]);
                }
            }
        }
    }

    // --- Service map ---
    const serviceMap = new Map<string, TransitService>();
    for (const s of services) serviceMap.set(s.id, s);

    return {
        stops: stopMap,
        patterns,
        stopPatterns,
        transfers: transferMap,
        services: serviceMap,
    };
}

// ---------------------------------------------------------------------------
// Service filtering — which services are active on the query date?
// ---------------------------------------------------------------------------

/** YYYYMMDD string from a Date (local time). */
function dateKey(d: Date): string {
    const y = d.getFullYear();
    const m = (d.getMonth() + 1).toString().padStart(2, "0");
    const day = d.getDate().toString().padStart(2, "0");
    return `${y}${m}${day}`;
}

function dayOfWeekBit(d: Date): number {
    // JS: 0 = Sunday ... 6 = Saturday
    // Our bitmask: bit 0 = Monday ... bit 6 = Sunday
    const jsDow = d.getDay();
    const bitPos = jsDow === 0 ? 6 : jsDow - 1;
    return 1 << bitPos;
}

export function activeServiceIds(
    services: Map<string, TransitService>,
    date: Date,
): Set<string> {
    const key = dateKey(date);
    const bit = dayOfWeekBit(date);
    const out = new Set<string>();
    for (const svc of services.values()) {
        // Explicit addition beats everything.
        if (svc.additions.includes(key)) {
            out.add(svc.id);
            continue;
        }
        // Explicit exception removes service for this date.
        if (svc.exceptions.includes(key)) continue;
        // Otherwise in-window + day-of-week bit.
        if (
            key >= svc.startDate &&
            key <= svc.endDate &&
            svc.daysOfWeek & bit
        ) {
            out.add(svc.id);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// The algorithm
// ---------------------------------------------------------------------------

export interface RaptorOptions {
    maxRounds?: number;
}

export function runRaptor(
    data: RaptorData,
    query: ReachabilityQuery,
    options: RaptorOptions = {},
): ReachabilityResult {
    const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
    const activeServices = activeServiceIds(data.services, query.departureTime);

    // Seconds since midnight of the query date.
    const queryDayMidnight = new Date(query.departureTime);
    queryDayMidnight.setHours(0, 0, 0, 0);
    const departureSecs =
        (query.departureTime.getTime() - queryDayMidnight.getTime()) / 1000;

    const budgetSecs = query.budgetMinutes * SECONDS_PER_MINUTE;
    const deadline = departureSecs + budgetSecs;

    const walkSpeedMps = (query.walkSpeedMph * METERS_PER_MILE) / 3600;
    const maxWalkLegSecs = query.maxWalkLegMinutes * SECONDS_PER_MINUTE;

    // -----------------------------------------------------------------------
    // Round 0: walk from origin to every stop within maxWalkLegMinutes.
    // -----------------------------------------------------------------------

    /** Best-so-far arrival time at each stop (Map avoids sparse-array cost). */
    const labels = new Map<string, number>();
    const walkReachableStopIds: string[] = [];

    const stopsInScope = filterStopsToSystems(data.stops, query.systemIds);

    for (const stop of stopsInScope) {
        const meters = haversineMeters(
            query.origin.lat,
            query.origin.lng,
            stop.lat,
            stop.lng,
        );
        const walkSecs = meters / walkSpeedMps;
        if (walkSecs > maxWalkLegSecs) continue;

        const arrival = departureSecs + walkSecs;
        if (arrival > deadline) continue;

        labels.set(stop.id, arrival);
        walkReachableStopIds.push(stop.id);
    }

    let markedStops = new Set(walkReachableStopIds);

    // -----------------------------------------------------------------------
    // Rounds 1..maxRounds: board one more transit leg each round.
    // -----------------------------------------------------------------------

    for (let round = 1; round <= maxRounds; round++) {
        if (markedStops.size === 0) break;

        // Phase 1: collect patterns that touch any marked stop, with the
        // earliest index at which they do. "Earliest index" matters because
        // we only relax the pattern from that stop onward.
        const queuedPatterns = new Map<string, number>(); // patternId -> earliestIdx
        for (const stopId of markedStops) {
            const entries = data.stopPatterns.get(stopId);
            if (!entries) continue;
            for (const e of entries) {
                const cur = queuedPatterns.get(e.patternId);
                if (cur === undefined || e.idxInPattern < cur) {
                    queuedPatterns.set(e.patternId, e.idxInPattern);
                }
            }
        }

        const improvedThisRound = new Set<string>();

        // Phase 2: relax each pattern.
        for (const [patternId, fromIdx] of queuedPatterns) {
            const pattern = data.patterns.get(patternId);
            if (!pattern) continue;

            // Walk the pattern starting at fromIdx. We track the currently-
            // boarded trip; we may re-board an earlier trip later in the
            // pattern only if our label at a stop improves (unchanged from
            // prior stops).
            let currentTripIdx = -1;
            let currentTripBoardArrival = Infinity;

            for (let i = fromIdx; i < pattern.stopIds.length; i++) {
                const stopId = pattern.stopIds[i];

                // If we're currently on a trip, see if it arrives at this
                // stop earlier than our current label.
                if (currentTripIdx !== -1) {
                    const trip = pattern.trips[currentTripIdx];
                    const arr = trip.arrivals[i];
                    const existing = labels.get(stopId) ?? Infinity;
                    if (arr < existing && arr <= deadline) {
                        labels.set(stopId, arr);
                        improvedThisRound.add(stopId);
                    }
                }

                // Can we (re-)board here earlier? Only if our current label
                // at this stop is earlier than the trip we're on (or we're
                // not on a trip yet).
                const labelHere = labels.get(stopId);
                if (
                    labelHere !== undefined &&
                    labelHere < currentTripBoardArrival
                ) {
                    const tripIdx = earliestBoardableTrip(
                        pattern,
                        i,
                        labelHere,
                        activeServices,
                    );
                    if (tripIdx !== -1) {
                        currentTripIdx = tripIdx;
                        currentTripBoardArrival =
                            pattern.trips[tripIdx].departures[i];
                    }
                }
            }
        }

        // Phase 3: footpath relaxation from improved stops only.
        for (const stopId of improvedThisRound) {
            const arr = labels.get(stopId)!;
            const transfers = data.transfers.get(stopId);
            if (!transfers) continue;
            for (const t of transfers) {
                // Enforce max-walk-leg on transfers too. The user set it
                // because they don't want to model unrealistic walks.
                if (t.seconds > maxWalkLegSecs) continue;

                const newArr = arr + t.seconds;
                if (newArr > deadline) continue;
                const existing = labels.get(t.toStopId) ?? Infinity;
                if (newArr < existing) {
                    labels.set(t.toStopId, newArr);
                    improvedThisRound.add(t.toStopId);
                }
            }
        }

        markedStops = improvedThisRound;
    }

    // Convert absolute arrival times -> seconds since departure (what callers
    // typically want to render as "reachable in X minutes").
    const arrivalSeconds = new Map<string, number>();
    for (const [stopId, arr] of labels) {
        arrivalSeconds.set(stopId, arr - departureSecs);
    }

    return {
        query,
        arrivalSeconds,
        walkReachableStopIds,
        computedAtMs: Date.now(),
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function filterStopsToSystems(
    stops: Map<string, TransitStop>,
    systemIds?: string[],
): TransitStop[] {
    if (!systemIds || systemIds.length === 0) {
        return [...stops.values()].filter((s) => (s.locationType ?? 0) === 0);
    }
    const allowed = new Set(systemIds);
    const out: TransitStop[] = [];
    for (const s of stops.values()) {
        if (allowed.has(s.systemId) && (s.locationType ?? 0) === 0) out.push(s);
    }
    return out;
}

/**
 * Binary search for the earliest trip whose departure at position `stopIdx`
 * is >= `earliestDeparture`, filtered to active services. Returns -1 if no
 * such trip exists.
 *
 * Note: we index by departure at stop 0, but we need departure at stopIdx.
 * For correctness we walk forward from the lower bound on stop 0 until we
 * find one whose departure at stopIdx is feasible. In well-behaved feeds
 * the two are monotonically related so we rarely scan more than a few trips.
 */
function earliestBoardableTrip(
    pattern: Pattern,
    stopIdx: number,
    earliestDeparture: number,
    activeServices: Set<string>,
): number {
    // Lower-bound on tripIdxByDeparture for earliestDeparture (departures[0]).
    // This is a heuristic start point — we may need to scan forward because
    // trips aren't strictly monotonic at arbitrary stops (express overtakes
    // local, etc).
    let lo = 0;
    let hi = pattern.tripIdxByDeparture.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (pattern.tripIdxByDeparture[mid] < earliestDeparture) lo = mid + 1;
        else hi = mid;
    }

    // Scan forward from lo looking for first trip that:
    //   - has active service
    //   - departs at `stopIdx` at or after `earliestDeparture`
    // Also scan a small window backwards because the lo index is a bound on
    // stop 0, and a later-starting trip may reach stopIdx sooner (but usually
    // doesn't). We bound the backwards scan at 4 for O(1) worst case.
    const back = Math.max(0, lo - 4);
    for (let i = back; i < pattern.trips.length; i++) {
        const trip = pattern.trips[i];
        if (!activeServices.has(trip.serviceId)) continue;
        if (trip.departures[stopIdx] >= earliestDeparture) return i;
    }
    return -1;
}

// Re-export haversine for callers that want origin->stop walking in UI.
export { haversineMeters };

// Re-export defaults for the client.
export { DEFAULT_MAX_ROUNDS };
