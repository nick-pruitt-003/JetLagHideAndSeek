/**
 * Auto-generated walking transfers between nearby stops.
 *
 * GTFS `transfers.txt` only documents intra-agency transfers (NYCT tells you
 * how to transfer between subway lines, but nothing says "walk from Penn
 * Station LIRR to Penn Station Subway" because those are different feeds).
 *
 * We fix this by building a k-d tree of every stop across every imported
 * system and emitting a Footpath between any two stops within
 * `maxDistanceMeters` of each other. This runs once per import (and once on
 * system removal) so the `transfersAuto` store is always in sync with the
 * current set of systems.
 *
 * Key design choices:
 *   - Parent stations are skipped as *endpoints* of transfers; only
 *     platform-level stops get edges. This avoids creating fake transfers
 *     that "teleport" a rider to a station entity that RAPTOR never actually
 *     boards at.
 *   - Both directions are emitted. RAPTOR treats footpaths as directed.
 *   - A fixed 30-second buffer is added to every walk time to account for
 *     wayfinding, stairs, fare gates, etc. This is conservative; for most
 *     in-station transfers GTFS transfers.txt will already exist and win.
 */

import KDBush from "kdbush";

import { openTransitDB, replaceAutoTransfers } from "./gtfs-store";
import type { Footpath, TransitStop } from "./types";

export interface AutoTransferOptions {
    /** Max straight-line distance to consider for a transfer edge. */
    maxDistanceMeters?: number;
    /** Walking speed in m/s (default ~2.0 m/s = 4.5 mph, the user's target). */
    walkSpeedMps?: number;
    /** Flat overhead added to every transfer (stairs, gates). Seconds. */
    bufferSeconds?: number;
}

const DEFAULTS: Required<AutoTransferOptions> = {
    maxDistanceMeters: 200,
    walkSpeedMps: 2.0,
    bufferSeconds: 30,
};

/**
 * Rebuild the `transfersAuto` store from scratch using all currently
 * imported stops. Safe to call concurrently with RAPTOR queries — RAPTOR
 * snapshots the transfer set at query start.
 */
export async function rebuildAutoTransfers(
    options: AutoTransferOptions = {},
): Promise<{ stopsConsidered: number; transfersGenerated: number }> {
    const opts = { ...DEFAULTS, ...options };

    const db = await openTransitDB();
    const allStops = await db.getAll("stops");

    // Platform-level stops only. location_type codes:
    //   0/undefined = stop/platform  <- keep
    //   1 = station                  <- skip (parent only)
    //   2 = entrance                 <- skip
    //   3 = generic node             <- skip
    //   4 = boarding area            <- skip
    const platforms = allStops.filter(
        (s) => (s.locationType ?? 0) === 0,
    );

    if (platforms.length === 0) {
        await replaceAutoTransfers([]);
        return { stopsConsidered: 0, transfersGenerated: 0 };
    }

    // KDBush indexes planar (x, y) points. We project lat/lng into a local
    // equirectangular approximation centered on the mean of the dataset.
    // Distortion is negligible inside any single metro area (<0.1% over
    // 100km), which is fine for 200m-scale transfer edges.
    const meanLat = avg(platforms.map((s) => s.lat));
    const latRad = (meanLat * Math.PI) / 180;
    // Meters per degree — spherical-earth constants.
    const mPerDegLat = 111_132;
    const mPerDegLng = 111_320 * Math.cos(latRad);

    const toXY = (s: TransitStop): [number, number] => [
        (s.lng - 0) * mPerDegLng, // x (meters east of prime meridian, roughly)
        (s.lat - 0) * mPerDegLat, // y (meters north of equator, roughly)
    ];

    const index = new KDBush(platforms.length);
    for (const s of platforms) {
        const [x, y] = toXY(s);
        index.add(x, y);
    }
    index.finish();

    // Walk every stop and find its neighbors. We emit each edge once per
    // direction (A→B and B→A) so RAPTOR doesn't have to know that Footpaths
    // are symmetric.
    const transfers: Footpath[] = [];
    const emitted = new Set<string>(); // "from:to"

    for (let i = 0; i < platforms.length; i++) {
        const from = platforms[i];
        const [x, y] = toXY(from);
        const neighborIdxs = index.within(x, y, opts.maxDistanceMeters);

        for (const j of neighborIdxs) {
            if (i === j) continue;
            const to = platforms[j];

            // Skip same-parent_station transfers — GTFS transfers.txt already
            // covers these with authoritative times, and if it doesn't, RAPTOR
            // treats same-parent stops as zero-cost via the parentStopId.
            if (
                from.parentStopId &&
                from.parentStopId === to.parentStopId
            ) {
                continue;
            }

            const dedupeKey = `${from.id}\x00${to.id}`;
            if (emitted.has(dedupeKey)) continue;
            emitted.add(dedupeKey);

            const meters = haversineMeters(from.lat, from.lng, to.lat, to.lng);
            // kdbush's radius was euclidean in our projected space; the true
            // haversine distance can be marginally larger. Re-check here to
            // avoid emitting edges slightly beyond the declared max.
            if (meters > opts.maxDistanceMeters) continue;

            const seconds = Math.round(
                meters / opts.walkSpeedMps + opts.bufferSeconds,
            );

            transfers.push({
                fromStopId: from.id,
                toStopId: to.id,
                seconds,
                source: "auto-proximity",
            });
        }
    }

    await replaceAutoTransfers(transfers);

    return {
        stopsConsidered: platforms.length,
        transfersGenerated: transfers.length,
    };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function avg(nums: number[]): number {
    let sum = 0;
    for (const n of nums) sum += n;
    return sum / nums.length;
}

/**
 * Great-circle distance in meters. Standard haversine — accurate to <0.5%
 * for any distance on Earth, which is fine for 200m-scale decisions.
 */
export function haversineMeters(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
): number {
    const R = 6_371_000;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

function toRad(deg: number): number {
    return (deg * Math.PI) / 180;
}
