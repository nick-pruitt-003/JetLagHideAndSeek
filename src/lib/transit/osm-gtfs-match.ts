/**
 * Match OSM station nodes (what ZoneSidebar fetches via Overpass) to
 * GTFS stop IDs so RAPTOR travel times can be attached to the existing
 * station markers on the map.
 *
 * Matching strategy, applied in order:
 *   1. Explicit crosswalk tag on the OSM node (ref:gtfs, gtfs:stop_id,
 *      etc). If present and a GTFS stop with that id exists, direct hit.
 *   2. Spatial + name fuzzy match. Find all GTFS stops within a search
 *      radius, score each by (distance, Jaccard name similarity), pick
 *      the highest-scoring candidate above minScore.
 *   3. Platforms are rolled up to their parent_station when one exists,
 *      so reachability lookups hit the station-level stop (which is what
 *      RAPTOR typically arrives at) rather than a single platform.
 *
 * The matcher returns the top N alternatives alongside the chosen best
 * match so the Phase 4 UI can show an "unknown/ambiguous" state and let
 * the user manually pick from the plausible candidates.
 */

import KDBush from "kdbush";

import { haversineMeters } from "./auto-transfers";
import type { TransitStop } from "./types";

/** OSM tags we'll look at for an explicit GTFS crosswalk. Order matters. */
const GTFS_REF_TAGS = [
    "gtfs:stop_id",
    "gtfs_stop_id",
    "ref:gtfs",
    "ref:GTFS",
    "gtfs_id",
    "gtfs:id",
] as const;

/**
 * Tokens we drop when computing name similarity. These are common noise
 * words that show up in both OSM and GTFS station names but carry no
 * discriminative signal ("Station", "Terminal", "Street", etc).
 *
 * Deliberately aggressive — subway/railway naming varies wildly between
 * agencies and mappers, and we'd rather tolerate a few false matches
 * than drop too many true ones. The UI surfaces alternatives for the
 * ambiguous cases.
 */
const NOISE_TOKENS = new Set([
    "station",
    "stop",
    "sta",
    "terminal",
    "terminus",
    "halt",
    "st",
    "street",
    "ave",
    "avenue",
    "blvd",
    "boulevard",
    "rd",
    "road",
    "dr",
    "drive",
    "ln",
    "lane",
    "sq",
    "square",
    "pk",
    "park",
    "plaza",
    "ctr",
    "center",
    "centre",
    "the",
    "and",
    "of",
    "at",
]);

/**
 * Normalize a station name into a set of comparable tokens.
 *
 *   "W 42nd St - Times Sq"   -> ["w", "42", "times"]
 *   "Times Square - 42 St"   -> ["times", "42"]
 *   "Grand Central Terminal" -> ["grand", "central"]
 *   "Grand Central - 42 St"  -> ["grand", "central", "42"]
 *
 * Ordinal suffixes on numbers are stripped so "42nd St" matches "42 St".
 */
export function normalizeStationName(raw: string): string[] {
    return (
        raw
            .toLowerCase()
            .normalize("NFKD")
            // collapse punctuation (but keep hyphen as a token separator)
            .replace(/[^\p{Letter}\p{Number}\s-]/gu, " ")
            // strip ordinal suffixes: "42nd" -> "42"
            .replace(/(\d+)(?:st|nd|rd|th)\b/g, "$1")
            .split(/[\s-]+/)
            .map((t) => t.trim())
            .filter((t) => t.length > 0 && !NOISE_TOKENS.has(t))
    );
}

/** Jaccard similarity of two station names after normalization. 0..1. */
export function nameSimilarity(a: string, b: string): number {
    const ta = new Set(normalizeStationName(a));
    const tb = new Set(normalizeStationName(b));
    if (ta.size === 0 || tb.size === 0) return 0;
    let intersection = 0;
    for (const t of ta) if (tb.has(t)) intersection++;
    const union = ta.size + tb.size - intersection;
    return intersection / union;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OsmStationInput {
    /** Stable OSM id used as the key for the returned match. */
    osmId: string;
    name: string;
    lat: number;
    lng: number;
    /** Raw OSM tags, if available. Used for explicit crosswalk lookup. */
    tags?: Record<string, string | undefined>;
}

export interface StopMatchCandidate {
    /** Prefixed GTFS stop id (`${systemId}:${gtfsStopId}`). */
    stopId: string;
    systemId: string;
    name: string;
    distanceMeters: number;
    /** 0..1 Jaccard similarity on normalized name tokens. */
    nameSimilarity: number;
    /** Combined weighted score used to rank candidates. 0..1. */
    score: number;
    method: "gtfs_ref" | "heuristic";
}

export interface MatchedStation {
    osmId: string;
    /** `null` if no candidate met the minScore threshold. */
    best: StopMatchCandidate | null;
    /** Other plausible candidates, best score first, excluding `best`. */
    alternatives: StopMatchCandidate[];
}

export interface MatchOptions {
    /** Max search radius in meters. Default 400 — covers a typical NYC
     *  subway entrance offset from the station centroid. */
    maxRadiusMeters?: number;
    /** Minimum combined score to accept as `best`. Default 0.35. */
    minScore?: number;
    /** Number of alternatives to keep after `best`. Default 3. */
    maxAlternatives?: number;
    /** Weight of distance-proximity vs name similarity. Must sum to 1
     *  (not enforced, just a convention). Defaults tuned for subway
     *  data where colocated stations with different names (e.g. LIRR
     *  Penn vs Subway Penn) are common. */
    distanceWeight?: number;
    nameWeight?: number;
}

const DEFAULTS: Required<MatchOptions> = {
    maxRadiusMeters: 400,
    minScore: 0.35,
    maxAlternatives: 3,
    distanceWeight: 0.4,
    nameWeight: 0.6,
};

// ---------------------------------------------------------------------------
// Spatial index
// ---------------------------------------------------------------------------

export interface StopIndex {
    /** Filtered subset of stops that participate in matching (parents + platforms). */
    stops: TransitStop[];
    byId: Map<string, TransitStop>;
    /** Lookup by raw (unprefixed) GTFS stop_id, for explicit crosswalk matches. */
    byGtfsId: Map<string, TransitStop[]>;
    /** kdbush index over the projected meter coords of `stops`. */
    idx: KDBush;
    /** Meters-per-degree-lat, meters-per-degree-lng for the dataset mean. */
    mPerDegLat: number;
    mPerDegLng: number;
}

/**
 * Build a spatial index over the GTFS stops to make many OSM matches
 * cheap. Indexes parent stations (locationType=1) and platforms
 * (locationType=0 or undefined). Drops entrances (2), nodes (3),
 * boarding areas (4) — they're noise for station-level matching.
 */
export function buildStopIndex(stops: TransitStop[]): StopIndex {
    const filtered = stops.filter((s) => {
        const lt = s.locationType ?? 0;
        return lt === 0 || lt === 1;
    });

    const byId = new Map<string, TransitStop>();
    const byGtfsId = new Map<string, TransitStop[]>();
    for (const s of filtered) {
        byId.set(s.id, s);
        const list = byGtfsId.get(s.gtfsStopId) ?? [];
        list.push(s);
        byGtfsId.set(s.gtfsStopId, list);
    }

    // Project lat/lng into a local equirectangular frame so kdbush's
    // euclidean `within(x, y, radius)` is meters. Same approach as
    // auto-transfers.ts — distortion is negligible at metro-area scale.
    const meanLat = filtered.length
        ? filtered.reduce((s, x) => s + x.lat, 0) / filtered.length
        : 0;
    const latRad = (meanLat * Math.PI) / 180;
    const mPerDegLat = 111_132;
    const mPerDegLng = 111_320 * Math.cos(latRad);

    const idx = new KDBush(filtered.length);
    for (const s of filtered) {
        idx.add(s.lng * mPerDegLng, s.lat * mPerDegLat);
    }
    idx.finish();

    return { stops: filtered, byId, byGtfsId, idx, mPerDegLat, mPerDegLng };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Match a batch of OSM stations against GTFS stops. Returns one result
 * per input station in input order. Pass a pre-built `StopIndex` when
 * matching against the same stop set repeatedly (e.g. re-running after
 * a reachability query) to avoid rebuilding the kdbush.
 */
export function matchOsmToGtfs(
    osm: OsmStationInput[],
    stopsOrIndex: TransitStop[] | StopIndex,
    options?: MatchOptions,
): MatchedStation[] {
    const opts = { ...DEFAULTS, ...options };
    const index = Array.isArray(stopsOrIndex)
        ? buildStopIndex(stopsOrIndex)
        : stopsOrIndex;

    const results: MatchedStation[] = [];
    for (const station of osm) {
        results.push(matchOne(station, index, opts));
    }
    return results;
}

function matchOne(
    station: OsmStationInput,
    index: StopIndex,
    opts: Required<MatchOptions>,
): MatchedStation {
    // 1) Explicit crosswalk tag — highest confidence, score pinned at 1.
    const explicit = resolveExplicitCrosswalk(station, index);

    // 2) Spatial + name fuzzy candidates.
    const heuristics = spatialFuzzyCandidates(station, index, opts);

    const uniq = dedupePreferringParents(heuristics, index.byId);

    let best: StopMatchCandidate | null = explicit;
    if (!best && uniq.length > 0 && uniq[0].score >= opts.minScore) {
        best = uniq[0];
    }

    const alternatives = uniq
        .filter((c) => !best || c.stopId !== best.stopId)
        .slice(0, opts.maxAlternatives);

    return { osmId: station.osmId, best, alternatives };
}

function resolveExplicitCrosswalk(
    station: OsmStationInput,
    index: StopIndex,
): StopMatchCandidate | null {
    if (!station.tags) return null;
    for (const tag of GTFS_REF_TAGS) {
        const raw = station.tags[tag];
        if (!raw) continue;
        const candidates = index.byGtfsId.get(raw.trim());
        if (!candidates?.length) continue;
        // Prefer a parent station (location_type=1) if one exists among
        // the matches, otherwise take the first.
        const chosen =
            candidates.find((c) => c.locationType === 1) ?? candidates[0];
        return {
            stopId: chosen.id,
            systemId: chosen.systemId,
            name: chosen.name,
            distanceMeters: haversineMeters(
                station.lat,
                station.lng,
                chosen.lat,
                chosen.lng,
            ),
            nameSimilarity: nameSimilarity(station.name, chosen.name),
            score: 1,
            method: "gtfs_ref",
        };
    }
    return null;
}

function spatialFuzzyCandidates(
    station: OsmStationInput,
    index: StopIndex,
    opts: Required<MatchOptions>,
): StopMatchCandidate[] {
    const x = station.lng * index.mPerDegLng;
    const y = station.lat * index.mPerDegLat;
    const neighborIdxs = index.idx.within(x, y, opts.maxRadiusMeters);

    const candidates: StopMatchCandidate[] = [];
    for (const i of neighborIdxs) {
        const s = index.stops[i];
        // Re-check with true haversine — kdbush.within is euclidean on our
        // projected plane and can be slightly more permissive than haversine.
        const d = haversineMeters(station.lat, station.lng, s.lat, s.lng);
        if (d > opts.maxRadiusMeters) continue;

        const sim = nameSimilarity(station.name, s.name);
        const distScore = Math.max(0, 1 - d / opts.maxRadiusMeters);
        const score = opts.distanceWeight * distScore + opts.nameWeight * sim;

        candidates.push({
            stopId: s.id,
            systemId: s.systemId,
            name: s.name,
            distanceMeters: d,
            nameSimilarity: sim,
            score,
            method: "heuristic",
        });
    }
    return candidates;
}

/**
 * Sort candidates by score desc. On near-ties (within 0.02) prefer the
 * parent station over a platform — RAPTOR arrivals are reported per
 * stop, and the parent is usually the better "station" representative.
 * After sort, keep only one candidate per prefixed stopId.
 */
function dedupePreferringParents(
    cands: StopMatchCandidate[],
    byId: Map<string, TransitStop>,
): StopMatchCandidate[] {
    const sorted = [...cands].sort((a, b) => {
        const aStop = byId.get(a.stopId);
        const bStop = byId.get(b.stopId);
        if (Math.abs(a.score - b.score) < 0.02 && aStop && bStop) {
            const aParent = aStop.locationType === 1 ? 1 : 0;
            const bParent = bStop.locationType === 1 ? 1 : 0;
            if (aParent !== bParent) return bParent - aParent;
        }
        return b.score - a.score;
    });

    const seen = new Set<string>();
    const out: StopMatchCandidate[] = [];
    for (const c of sorted) {
        if (seen.has(c.stopId)) continue;
        seen.add(c.stopId);
        out.push(c);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Parent rollup
// ---------------------------------------------------------------------------

/**
 * If `stopId` refers to a platform (location_type=0) with a parent
 * station that exists in the index, return the parent's id. Otherwise
 * return `stopId` unchanged. Used when looking up a reachability time:
 * an OSM "station" node conceptually represents the parent, but the
 * best spatial match can easily be a nearby platform.
 *
 * RAPTOR populates arrivals for every board/alight stop, which in most
 * feeds are platforms, so callers should probably check BOTH the match
 * and the parent — use {@link lookupArrivalWithParentFallback} for
 * convenience.
 */
export function rollUpToParent(
    stopId: string,
    byId: Map<string, TransitStop>,
): string {
    const s = byId.get(stopId);
    if (!s) return stopId;
    const lt = s.locationType ?? 0;
    if (lt === 0 && s.parentStopId && byId.has(s.parentStopId)) {
        return s.parentStopId;
    }
    return stopId;
}

/**
 * Look up an arrival time for `stopId`, falling back to the parent
 * station (or any sibling platform of the parent) if the stop itself
 * isn't in the arrivals map. Returns the minimum arrival across all
 * checked candidates — treating the station as "reachable by whenever
 * its fastest platform is reachable".
 */
export function lookupArrivalWithParentFallback(
    stopId: string,
    arrivals: ReadonlyMap<string, number>,
    byId: Map<string, TransitStop>,
): number | undefined {
    const checked = new Set<string>();
    let best: number | undefined;

    const consider = (id: string) => {
        if (checked.has(id)) return;
        checked.add(id);
        const a = arrivals.get(id);
        if (a !== undefined && (best === undefined || a < best)) best = a;
    };

    consider(stopId);

    const s = byId.get(stopId);
    if (!s) return best;

    // If we're a platform, also check the parent and every sibling
    // platform that shares the same parent.
    if ((s.locationType ?? 0) === 0 && s.parentStopId) {
        consider(s.parentStopId);
        for (const other of byId.values()) {
            if (other.parentStopId === s.parentStopId && other.id !== s.id) {
                consider(other.id);
            }
        }
    }

    // If we're a parent station, check every child.
    if (s.locationType === 1) {
        for (const other of byId.values()) {
            if (other.parentStopId === s.id) consider(other.id);
        }
    }

    return best;
}
