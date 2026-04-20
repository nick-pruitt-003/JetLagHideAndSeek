/**
 * Main-thread client wrapper around the reachability Web Worker.
 *
 * Callers use `reachabilityClient.query(query)`; the wrapper handles:
 *   - spinning up the worker on first use (lazy)
 *   - assigning request IDs and correlating responses
 *   - progress callbacks
 *   - cache invalidation after GTFS imports
 *
 * The worker is long-lived — we keep the same worker for the page lifetime
 * so its in-memory graph is reused across queries.
 */

import type {
    SerializedQuery,
    SerializedResult,
    WorkerRequest,
    WorkerResponse,
} from "@/lib/transit/reachability-worker";
import type { ReachabilityQuery, ReachabilityResult } from "@/lib/transit/types";

export interface QueryOptions {
    maxRounds?: number;
    onProgress?: (message: string) => void;
    signal?: AbortSignal;
}

class ReachabilityClient {
    private worker: Worker | null = null;
    private nextId = 1;
    private pending = new Map<
        number,
        {
            resolve: (r: ReachabilityResult) => void;
            reject: (e: Error) => void;
            onProgress?: (msg: string) => void;
        }
    >();

    /**
     * Create the worker. We use the Vite-native `new Worker(new URL(...))`
     * pattern so the bundle hashing and module graph work correctly in both
     * dev and build.
     */
    private ensureWorker(): Worker {
        if (this.worker) return this.worker;
        this.worker = new Worker(
            new URL("./reachability-worker.ts", import.meta.url),
            { type: "module" },
        );
        this.worker.addEventListener(
            "message",
            (ev: MessageEvent<WorkerResponse>) => {
                this.handleMessage(ev.data);
            },
        );
        this.worker.addEventListener("error", (ev) => {
            // Surface worker-script-level errors by rejecting all pending.
            for (const p of this.pending.values()) {
                p.reject(new Error(`Worker error: ${ev.message}`));
            }
            this.pending.clear();
        });
        return this.worker;
    }

    private handleMessage(msg: WorkerResponse): void {
        if (msg.type === "ready") return; // initial handshake

        const handler = this.pending.get(msg.id);
        if (!handler) return;

        switch (msg.type) {
            case "progress":
                handler.onProgress?.(msg.message);
                return; // don't remove from pending — more messages coming
            case "result":
                this.pending.delete(msg.id);
                handler.resolve(deserializeResult(msg.result));
                return;
            case "error":
                this.pending.delete(msg.id);
                handler.reject(new Error(msg.message));
                return;
            case "cacheStats":
                // cacheStats has its own pending entry; resolve with the
                // stats. (We smuggle it through the generic resolver by
                // casting; callers that wanted stats will check the shape.)
                // Cleaner would be a separate pending map, but cacheStats
                // is diagnostic only.
                this.pending.delete(msg.id);

                (handler as any).resolve(msg.stats);
                return;
        }
    }

    query(
        query: ReachabilityQuery,
        options: QueryOptions = {},
    ): Promise<ReachabilityResult> {
        const worker = this.ensureWorker();
        const id = this.nextId++;

        return new Promise<ReachabilityResult>((resolve, reject) => {
            this.pending.set(id, {
                resolve,
                reject,
                onProgress: options.onProgress,
            });

            if (options.signal) {
                options.signal.addEventListener("abort", () => {
                    if (this.pending.delete(id)) {
                        reject(new DOMException("Aborted", "AbortError"));
                    }
                });
            }

            const req: WorkerRequest = {
                id,
                type: "query",
                query: serializeQuery(query),
                maxRounds: options.maxRounds,
            };
            worker.postMessage(req);
        });
    }

    /**
     * Tell the worker to drop its cached graph and query cache. Call after
     * an import/deletion changes the underlying GTFS data.
     */
    invalidate(): void {
        if (!this.worker) return;
        this.worker.postMessage({
            id: this.nextId++,
            type: "invalidate",
        } satisfies WorkerRequest);
    }

    cacheStats(): Promise<{ entries: number; approxBytes: number }> {
        const worker = this.ensureWorker();
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as any, reject });
            worker.postMessage({
                id,
                type: "cacheStats",
            } satisfies WorkerRequest);
        });
    }

    /**
     * Tear down the worker. Useful for tests; production code should leave
     * it running for the page lifetime.
     */
    dispose(): void {
        this.worker?.terminate();
        this.worker = null;
        this.pending.clear();
    }
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function serializeQuery(q: ReachabilityQuery): SerializedQuery {
    return {
        origin: q.origin,
        departureTimeISO: q.departureTime.toISOString(),
        budgetMinutes: q.budgetMinutes,
        walkSpeedMph: q.walkSpeedMph,
        maxWalkLegMinutes: q.maxWalkLegMinutes,
        systemIds: q.systemIds,
    };
}

function deserializeResult(r: SerializedResult): ReachabilityResult {
    return {
        query: {
            origin: r.query.origin,
            departureTime: new Date(r.query.departureTimeISO),
            budgetMinutes: r.query.budgetMinutes,
            walkSpeedMph: r.query.walkSpeedMph,
            maxWalkLegMinutes: r.query.maxWalkLegMinutes,
            systemIds: r.query.systemIds,
        },
        arrivalSeconds: new Map(r.arrivals),
        walkReachableStopIds: r.walkReachableStopIds,
        computedAtMs: r.computedAtMs,
    };
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const reachabilityClient = new ReachabilityClient();
