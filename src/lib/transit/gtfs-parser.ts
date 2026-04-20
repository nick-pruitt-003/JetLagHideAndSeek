/**
 * Browser-side GTFS parser.
 *
 * Input: a zipped GTFS feed (either raw bytes from `fetchGtfsZip` or a
 * user-uploaded `File`).
 * Output: app-level transit records ready to persist via `gtfs-store.ts`.
 *
 * Design notes:
 *   - We use `fflate`'s synchronous `unzipSync` because GTFS zips are usually
 *     10–100 MB, which is well under what sync unzip can handle on modern
 *     hardware (<1s for NYC subway, ~3s for NJT). Running in a worker would
 *     be better; the caller can (and should) invoke this from one.
 *   - `papaparse` is used in synchronous mode on the in-memory strings
 *     rather than streaming mode. Streaming is slower for already-in-memory
 *     data because it doesn't help us do anything incremental here — we
 *     still need the full parse before we can store.
 *   - Only passenger-rail route types are kept (tram, subway, rail,
 *     monorail). Bus and ferry rows are discarded at parse time so we never
 *     carry them into IDB. This keeps the NYCT bus feed (20× larger than
 *     subway) from accidentally landing in someone's storage if they paste
 *     the wrong URL.
 *   - All IDs emerge prefixed with `${systemId}:` so callers can merge
 *     multiple feeds without collisions.
 */

import { strFromU8, unzipSync } from "fflate";
import Papa from "papaparse";

import type {
    Footpath,
    ImportProgress,
    TransitRoute,
    TransitService,
    TransitStop,
    TransitSystem,
    TransitTrip,
    TransitTripStopTimes,
} from "./types";

/**
 * Route types we keep. GTFS reference:
 *   0  Tram, Streetcar, Light rail
 *   1  Subway, Metro
 *   2  Rail
 *   12 Monorail
 *
 * Intentionally excluding bus (3), ferry (4), cable tram (5), aerial
 * lift (6), funicular (7), trolleybus (11). User's scope: "subway and
 * railway stations".
 */
const PASSENGER_RAIL_ROUTE_TYPES = new Set([0, 1, 2, 12]);

export interface ParsedFeed {
    system: TransitSystem;
    stops: TransitStop[];
    routes: TransitRoute[];
    trips: TransitTrip[];
    tripStopTimes: TransitTripStopTimes[];
    services: TransitService[];
    /** Transfers from the GTFS transfers.txt file, if present. */
    gtfsTransfers: Footpath[];
}

export interface ParseOptions {
    systemId: string;
    /** Human-readable name to store on the TransitSystem row. */
    name: string;
    sourceUrl?: string;
    importMethod: TransitSystem["importMethod"];
    onProgress?: (progress: ImportProgress) => void;
}

/**
 * Parse a GTFS zip. `input` may be an ArrayBuffer (from a fetch) or a
 * `File`/`Blob` (from an upload).
 */
export async function parseGtfs(
    input: ArrayBuffer | Blob,
    options: ParseOptions,
): Promise<ParsedFeed> {
    const { systemId, name, sourceUrl, importMethod, onProgress } = options;
    const prefix = (id: string) => `${systemId}:${id}`;

    // ----- 1. Unzip ---------------------------------------------------------

    onProgress?.({ phase: "unzipping", fraction: 0.05 });

    const buf =
        input instanceof ArrayBuffer
            ? new Uint8Array(input)
            : new Uint8Array(await input.arrayBuffer());
    const entries = unzipSync(buf);

    const readText = (filename: string): string | null => {
        // GTFS zips sometimes have files nested in a top-level dir. Find by
        // endsWith rather than exact match.
        const matchingKey = Object.keys(entries).find(
            (k) => k === filename || k.endsWith(`/${filename}`),
        );
        return matchingKey ? strFromU8(entries[matchingKey]) : null;
    };

    const required = ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt"];
    for (const r of required) {
        if (!readText(r)) {
            throw new Error(
                `Missing required GTFS file "${r}" in zip. ` +
                    `This may not be a valid GTFS feed.`,
            );
        }
    }

    // ----- 2. Parse routes (first — drives what stops/trips we keep) ---------

    onProgress?.({ phase: "parsing-routes", fraction: 0.12 });

    const routesCsv = readText("routes.txt")!;
    type RouteRow = {
        route_id: string;
        agency_id?: string;
        route_short_name?: string;
        route_long_name?: string;
        route_type: string;
    };
    const routeRows = parseCsv<RouteRow>(routesCsv);

    const routes: TransitRoute[] = [];
    const keptRouteIds = new Set<string>(); // unprefixed
    const routeTypesPresent = new Set<number>();
    let agencyForName: string | undefined;

    for (const row of routeRows) {
        const routeType = parseInt(row.route_type, 10);
        if (!PASSENGER_RAIL_ROUTE_TYPES.has(routeType)) continue;
        keptRouteIds.add(row.route_id);
        routeTypesPresent.add(routeType);
        if (!agencyForName && row.agency_id) agencyForName = row.agency_id;
        routes.push({
            id: prefix(row.route_id),
            systemId,
            gtfsRouteId: row.route_id,
            shortName: row.route_short_name,
            longName: row.route_long_name,
            routeType,
        });
    }

    if (routes.length === 0) {
        throw new Error(
            "No subway/rail routes found in this feed. " +
                "If this is a bus-only feed, it's not supported here.",
        );
    }

    // ----- 3. Parse trips ---------------------------------------------------

    onProgress?.({ phase: "parsing-trips", fraction: 0.22 });

    const tripsCsv = readText("trips.txt")!;
    type TripRow = {
        trip_id: string;
        route_id: string;
        service_id: string;
        trip_headsign?: string;
        direction_id?: string;
    };
    const tripRows = parseCsv<TripRow>(tripsCsv);

    const trips: TransitTrip[] = [];
    const keptTripIds = new Set<string>(); // unprefixed
    const serviceIdsUsed = new Set<string>(); // unprefixed

    for (const row of tripRows) {
        if (!keptRouteIds.has(row.route_id)) continue;
        keptTripIds.add(row.trip_id);
        serviceIdsUsed.add(row.service_id);
        trips.push({
            id: prefix(row.trip_id),
            systemId,
            gtfsTripId: row.trip_id,
            routeId: prefix(row.route_id),
            serviceId: prefix(row.service_id),
            headsign: row.trip_headsign,
            directionId: row.direction_id
                ? parseInt(row.direction_id, 10)
                : undefined,
        });
    }

    // ----- 4. Parse stop_times (biggest file — stream in chunks) ------------

    onProgress?.({ phase: "parsing-stop-times", fraction: 0.32 });

    const stopTimesCsv = readText("stop_times.txt")!;
    type StopTimeRow = {
        trip_id: string;
        arrival_time: string;
        departure_time: string;
        stop_id: string;
        stop_sequence: string;
    };

    // Group by trip_id while parsing. Using a Map preserves insertion order,
    // but stop_times.txt is not guaranteed sorted by stop_sequence, so we
    // still need to sort per trip at the end.
    const tripStopsRaw = new Map<
        string,
        {
            seqs: number[];
            stopIds: string[];
            arrivals: number[];
            departures: number[];
        }
    >();
    const keptStopIds = new Set<string>(); // unprefixed — stops to include

    // Parse synchronously. stop_times.txt is the biggest file (10-200 MB for
    // NY-area feeds) but papaparse chews through it in <1s on modern hardware,
    // and we're in a worker anyway. Reporting progress every N rows.
    const parseResult = Papa.parse<StopTimeRow>(stopTimesCsv, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: false,
    });
    const rows = parseResult.data;
    const progressStride = Math.max(1, Math.floor(rows.length / 20));

    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
        const row = rows[rowIdx];
        if (!row.trip_id || !keptTripIds.has(row.trip_id)) continue;
        let entry = tripStopsRaw.get(row.trip_id);
        if (!entry) {
            entry = { seqs: [], stopIds: [], arrivals: [], departures: [] };
            tripStopsRaw.set(row.trip_id, entry);
        }
        entry.seqs.push(parseInt(row.stop_sequence, 10));
        entry.stopIds.push(row.stop_id);
        entry.arrivals.push(parseGtfsTime(row.arrival_time));
        entry.departures.push(parseGtfsTime(row.departure_time));
        keptStopIds.add(row.stop_id);

        if (rowIdx % progressStride === 0) {
            const frac = 0.32 + 0.3 * (rowIdx / rows.length);
            onProgress?.({ phase: "parsing-stop-times", fraction: frac });
        }
    }

    // Sort each trip's stop times by stop_sequence and build the compact
    // TransitTripStopTimes records.
    const tripStopTimes: TransitTripStopTimes[] = [];
    for (const [tripId, raw] of tripStopsRaw) {
        const order = raw.seqs
            .map((_s, i) => i)
            .sort((a, b) => raw.seqs[a] - raw.seqs[b]);
        tripStopTimes.push({
            tripId: prefix(tripId),
            systemId,
            stopIds: order.map((i) => prefix(raw.stopIds[i])),
            arrivals: order.map((i) => raw.arrivals[i]),
            departures: order.map((i) => raw.departures[i]),
        });
    }

    // ----- 5. Parse stops ---------------------------------------------------

    onProgress?.({ phase: "parsing-stops", fraction: 0.68 });

    const stopsCsv = readText("stops.txt")!;
    type StopRow = {
        stop_id: string;
        stop_name: string;
        stop_lat: string;
        stop_lon: string;
        location_type?: string;
        parent_station?: string;
    };
    const stopRows = parseCsv<StopRow>(stopsCsv);

    // We keep any stop that (a) was referenced in our filtered stop_times OR
    // (b) is a parent_station of such a stop. We run two passes: first pass
    // collects referenced stops + their declared parent ids; second pass
    // walks up to add the parents themselves.
    const parentIdsToAlsoKeep = new Set<string>();
    const stopRowById = new Map<string, StopRow>();
    for (const row of stopRows) {
        stopRowById.set(row.stop_id, row);
    }
    for (const id of keptStopIds) {
        const row = stopRowById.get(id);
        if (row?.parent_station) parentIdsToAlsoKeep.add(row.parent_station);
    }

    const stops: TransitStop[] = [];
    for (const row of stopRows) {
        if (
            !keptStopIds.has(row.stop_id) &&
            !parentIdsToAlsoKeep.has(row.stop_id)
        ) {
            continue;
        }
        const lat = parseFloat(row.stop_lat);
        const lng = parseFloat(row.stop_lon);
        if (!isFinite(lat) || !isFinite(lng)) continue;
        stops.push({
            id: prefix(row.stop_id),
            systemId,
            gtfsStopId: row.stop_id,
            name: row.stop_name,
            lat,
            lng,
            locationType: row.location_type
                ? parseInt(row.location_type, 10)
                : 0,
            parentStopId: row.parent_station
                ? prefix(row.parent_station)
                : undefined,
        });
    }

    // ----- 6. Parse calendar + calendar_dates -------------------------------

    onProgress?.({ phase: "parsing-calendar", fraction: 0.78 });

    const services: TransitService[] = [];
    const servicesById = new Map<string, TransitService>();
    let calendarStart: string | undefined;
    let calendarEnd: string | undefined;

    const calendarCsv = readText("calendar.txt");
    if (calendarCsv) {
        type CalRow = {
            service_id: string;
            monday: string;
            tuesday: string;
            wednesday: string;
            thursday: string;
            friday: string;
            saturday: string;
            sunday: string;
            start_date: string;
            end_date: string;
        };
        for (const row of parseCsv<CalRow>(calendarCsv)) {
            if (!serviceIdsUsed.has(row.service_id)) continue;
            // Bitmask: bit 0 = Monday ... bit 6 = Sunday
            let days = 0;
            if (row.monday === "1") days |= 1 << 0;
            if (row.tuesday === "1") days |= 1 << 1;
            if (row.wednesday === "1") days |= 1 << 2;
            if (row.thursday === "1") days |= 1 << 3;
            if (row.friday === "1") days |= 1 << 4;
            if (row.saturday === "1") days |= 1 << 5;
            if (row.sunday === "1") days |= 1 << 6;
            const svc: TransitService = {
                id: prefix(row.service_id),
                systemId,
                gtfsServiceId: row.service_id,
                daysOfWeek: days,
                startDate: row.start_date,
                endDate: row.end_date,
                additions: [],
                exceptions: [],
            };
            services.push(svc);
            servicesById.set(row.service_id, svc);
            if (!calendarStart || row.start_date < calendarStart) {
                calendarStart = row.start_date;
            }
            if (!calendarEnd || row.end_date > calendarEnd) {
                calendarEnd = row.end_date;
            }
        }
    }

    const calDatesCsv = readText("calendar_dates.txt");
    if (calDatesCsv) {
        type DateRow = {
            service_id: string;
            date: string;
            exception_type: string;
        };
        for (const row of parseCsv<DateRow>(calDatesCsv)) {
            if (!serviceIdsUsed.has(row.service_id)) continue;
            let svc = servicesById.get(row.service_id);
            if (!svc) {
                // Services defined only in calendar_dates (rare but valid;
                // e.g. NJT uses this pattern for some school-day services).
                svc = {
                    id: prefix(row.service_id),
                    systemId,
                    gtfsServiceId: row.service_id,
                    daysOfWeek: 0,
                    startDate: row.date,
                    endDate: row.date,
                    additions: [],
                    exceptions: [],
                };
                services.push(svc);
                servicesById.set(row.service_id, svc);
            }
            if (row.exception_type === "1") svc.additions.push(row.date);
            else if (row.exception_type === "2") svc.exceptions.push(row.date);
        }
    }

    // ----- 7. Parse transfers.txt (optional) --------------------------------

    onProgress?.({ phase: "parsing-transfers", fraction: 0.9 });

    const gtfsTransfers: Footpath[] = [];
    const transfersCsv = readText("transfers.txt");
    if (transfersCsv) {
        type TransferRow = {
            from_stop_id: string;
            to_stop_id: string;
            transfer_type: string;
            min_transfer_time?: string;
        };
        for (const row of parseCsv<TransferRow>(transfersCsv)) {
            const type = parseInt(row.transfer_type, 10);
            if (type === 3) continue; // "not possible"
            // Only include transfers between stops we actually kept.
            if (
                !keptStopIds.has(row.from_stop_id) &&
                !parentIdsToAlsoKeep.has(row.from_stop_id)
            )
                continue;
            if (
                !keptStopIds.has(row.to_stop_id) &&
                !parentIdsToAlsoKeep.has(row.to_stop_id)
            )
                continue;
            // min_transfer_time is seconds. Default to 120s when absent
            // (a reasonable "walk across the platform" estimate).
            const seconds = row.min_transfer_time
                ? parseInt(row.min_transfer_time, 10)
                : 120;
            gtfsTransfers.push({
                fromStopId: prefix(row.from_stop_id),
                toStopId: prefix(row.to_stop_id),
                seconds,
                source: "gtfs",
            });
        }
    }

    // ----- 8. Build system record ------------------------------------------

    onProgress?.({ phase: "storing", fraction: 0.95 });

    const now = Date.now();
    const system: TransitSystem = {
        id: systemId,
        name,
        agency: agencyForName,
        importedAt: now,
        refreshedAt: now,
        sourceUrl,
        importMethod,
        stopCount: stops.length,
        tripCount: trips.length,
        routeTypes: Array.from(routeTypesPresent).sort((a, b) => a - b),
        calendarStart,
        calendarEnd,
    };

    return {
        system,
        stops,
        routes,
        trips,
        tripStopTimes,
        services,
        gtfsTransfers,
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse GTFS time strings ("HH:MM:SS", possibly >= "24:00:00" for overnight
 * trips) into seconds since midnight of the service start day. Returns 0 on
 * malformed input — callers should treat 0 as "missing" since GTFS uses
 * "00:00:00" explicitly when service literally starts at midnight (rare).
 */
function parseGtfsTime(time: string | undefined): number {
    if (!time) return 0;
    const parts = time.split(":");
    if (parts.length !== 3) return 0;
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const s = parseInt(parts[2], 10);
    if (!isFinite(h) || !isFinite(m) || !isFinite(s)) return 0;
    return h * 3600 + m * 60 + s;
}

function parseCsv<T>(text: string): T[] {
    const result = Papa.parse<T>(text, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: false,
    });
    return result.data;
}
