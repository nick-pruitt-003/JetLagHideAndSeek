/**
 * Web Worker entry for reachability queries.
 *
 * The worker boots lazily: the first `query` request triggers a full load of
 * the RAPTOR data structure from IndexedDB (~1–5s on NYC-scale data). After
 * that, subsequent queries reuse the in-memory graph and cache and complete
 * in ~50–500ms.
 *
 * Message protocol (all typed via `WorkerRequest`/`WorkerResponse` below):
 *
 *   MAIN -> WORKER:
 *     { id, type: "query",        query }
 *     { id, type: "invalidate" }         // drop cached data (after an import)
 *     { id, type: "cacheStats" }
 *
 *   WORKER -> MAIN:
 *     { id, type: "ready" }              // one-time, after boot
 *     { id, type: "progress", message }  // while loading data
 *     { id, type: "result", result }
 *     { id, type: "error", message }
 *     { id, type: "cacheStats", stats }
 */

import { loadRaptorData, type RaptorData, runRaptor } from "./raptor";
import type { ReachabilityQuery, ReachabilityResult } from "./types";

// ---------------------------------------------------------------------------
// Message protocol
// ---------------------------------------------------------------------------

export type WorkerRequest =
    | { id: number; type: "query"; query: SerializedQuery; maxRounds?: number }
    | { id: number; type: "invalidate" }
    | { id: number; type: "cacheStats" };

export type WorkerResponse =
    | { id: number; type: "ready" }
    | { id: number; type: "progress"; message: string }
    | { id: number; type: "result"; result: SerializedResult }
    | { id: number; type: "error"; message: string }
    | {
          id: number;
          type: "cacheStats";
          stats: { entries: number; approxBytes: number };
      };

// ---------------------------------------------------------------------------
// Wire-format types (Maps and Dates don't survive structured clone cleanly
// across worker boundaries in all browsers — we serialize defensively).
// ---------------------------------------------------------------------------

export interface SerializedQuery {
    origin: { lat: number; lng: number };
    departureTimeISO: string;
    budgetMinutes: number;
    walkSpeedMph: number;
    maxWalkLegMinutes: number;
    systemIds?: string[];
}

export interface SerializedResult {
    query: SerializedQuery;
    /** Entries of the arrivalSeconds map. */
    arrivals: Array<[string, number]>;
    walkReachableStopIds: string[];
    computedAtMs: number;
}

// ---------------------------------------------------------------------------
// Worker state (in-memory, lost on page reload)
// ---------------------------------------------------------------------------

let data: RaptorData | null = null;
const cache = new Map<string, SerializedResult>();
const CACHE_CAP = 32;

function cacheKey(q: SerializedQuery, maxRounds: number | undefined): string {
    // Round origin to ~1m precision so near-identical queries hit the cache.
    const lat = q.origin.lat.toFixed(5);
    const lng = q.origin.lng.toFixed(5);
    const sys = q.systemIds?.slice().sort().join(",") ?? "";
    return [
        lat,
        lng,
        q.departureTimeISO,
        q.budgetMinutes,
        q.walkSpeedMph,
        q.maxWalkLegMinutes,
        sys,
        maxRounds ?? "",
    ].join("|");
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function ensureLoaded(id: number): Promise<RaptorData> {
    if (data) return data;
    postProgress(id, "Loading transit graph from IndexedDB…");
    data = await loadRaptorData();
    postProgress(
        id,
        `Loaded ${data.stops.size} stops, ${data.patterns.size} patterns.`,
    );
    return data;
}

async function handleQuery(
    id: number,
    q: SerializedQuery,
    maxRounds: number | undefined,
): Promise<void> {
    try {
        const key = cacheKey(q, maxRounds);
        const cached = cache.get(key);
        if (cached) {
            postMessage({
                id,
                type: "result",
                result: cached,
            } satisfies WorkerResponse);
            return;
        }

        const d = await ensureLoaded(id);
        const query: ReachabilityQuery = {
            origin: q.origin,
            departureTime: new Date(q.departureTimeISO),
            budgetMinutes: q.budgetMinutes,
            walkSpeedMph: q.walkSpeedMph,
            maxWalkLegMinutes: q.maxWalkLegMinutes,
            systemIds: q.systemIds,
        };

        const result: ReachabilityResult = runRaptor(d, query, { maxRounds });
        const serialized: SerializedResult = {
            query: q,
            arrivals: [...result.arrivalSeconds],
            walkReachableStopIds: result.walkReachableStopIds,
            computedAtMs: result.computedAtMs,
        };

        // LRU-ish cache: drop the first (oldest) entry if over cap.
        if (cache.size >= CACHE_CAP) {
            const firstKey = cache.keys().next().value;
            if (firstKey !== undefined) cache.delete(firstKey);
        }
        cache.set(key, serialized);

        postMessage({
            id,
            type: "result",
            result: serialized,
        } satisfies WorkerResponse);
    } catch (err) {
        postMessage({
            id,
            type: "error",
            message: err instanceof Error ? err.message : String(err),
        } satisfies WorkerResponse);
    }
}

function handleInvalidate(id: number): void {
    data = null;
    cache.clear();
    postMessage({
        id,
        type: "progress",
        message: "Cache cleared.",
    } satisfies WorkerResponse);
}

function handleCacheStats(id: number): void {
    // Approximate byte count — each cached result is ~stopCount * ~30 bytes.
    let approxBytes = 0;
    for (const r of cache.values()) {
        approxBytes += r.arrivals.length * 30 + 200;
    }
    postMessage({
        id,
        type: "cacheStats",
        stats: { entries: cache.size, approxBytes },
    } satisfies WorkerResponse);
}

function postProgress(id: number, message: string): void {
    postMessage({ id, type: "progress", message } satisfies WorkerResponse);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

self.addEventListener("message", (ev: MessageEvent<WorkerRequest>) => {
    const req = ev.data;
    switch (req.type) {
        case "query":
            void handleQuery(req.id, req.query, req.maxRounds);
            break;
        case "invalidate":
            handleInvalidate(req.id);
            break;
        case "cacheStats":
            handleCacheStats(req.id);
            break;
    }
});

// Let the client know the worker script itself has evaluated.
postMessage({ id: -1, type: "ready" } satisfies WorkerResponse);
