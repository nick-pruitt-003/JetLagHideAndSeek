/**
 * Persistent map overlay showing how many stations a hider could still be at
 * inside the current playable territory.
 *
 * The count comes from {@link trainStations} — the same Overpass-derived set
 * that draws the hiding-zone circles on the map, i.e. *every* qualifying
 * station, since a team may hide at any subway station rather than only the
 * major ones. Until zones have been computed there is nothing live to count,
 * so the panel falls back to a bundled regional rail list and says so.
 *
 * Covers: NYC Subway, MTA LIRR, MTA Metro-North, NJ Transit (rail + light
 * rail), SEPTA, Amtrak, and Hartford Line — useful for NJ/NY/CT/PA games.
 */

import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import { useEffect, useMemo } from "react";

import { METRO_AREA_RAIL_STATIONS } from "@/data/metro-area-rail-stations";
import { NYC_MAJOR_SUBWAY_STATIONS } from "@/data/nyc-subway-major-stations";
import {
    playableTerritoryUnion,
    stationCountBaseline,
    trainStations,
} from "@/lib/context";
import { countByOperator } from "@/lib/station-grouping";
import { cn } from "@/lib/utils";

// Bundled fallback, used only before any hiding zones have been computed.
// Each entry just needs { lat, lng } for the point-in-polygon check.
const FALLBACK_STATIONS = [
    ...NYC_MAJOR_SUBWAY_STATIONS.map((s) => ({
        lat: s.lat,
        lng: s.lng,
        system: "Subway" as const,
    })),
    ...METRO_AREA_RAIL_STATIONS.map((s) => ({
        lat: s.lat,
        lng: s.lng,
        system: s.system,
    })),
];

const FALLBACK_TOTAL = FALLBACK_STATIONS.length;

// Display-friendly label for each bundled system key. The subway entry is the
// curated "major stations" list (the one the random-start draw uses), which is
// a fraction of the ~470-station system — qualify it so the fallback number
// isn't read as "every subway station".
const SYSTEM_LABEL: Record<string, string> = {
    Subway: "NYC Subway (major only)",
    LIRR: "LIRR",
    MNR: "Metro-North",
    NJT: "NJ Transit",
    NJLR: "NJ Light Rail",
    SEPTA: "SEPTA",
    Amtrak: "Amtrak",
    HartfordLine: "Hartford Line",
};

export const StationCountIndicator = () => {
    const $territory = useStore(playableTerritoryUnion);
    const $trainStations = useStore(trainStations);
    const $baseline = useStore(stationCountBaseline);

    const liveCount = $trainStations.length;
    const hasLiveStations = liveCount > 0;

    // Remember the largest field this game has had so the gauge has an honest
    // denominator. Territory can also grow (a region added mid-setup), so take
    // the max rather than only the first value seen.
    useEffect(() => {
        if (!hasLiveStations) return;
        if ($baseline === null || liveCount > $baseline) {
            stationCountBaseline.set(liveCount);
        }
    }, [hasLiveStations, liveCount, $baseline]);

    const fallback = useMemo(() => {
        if (hasLiveStations) return null;

        const bySystem: Record<string, number> = {};
        if (!$territory) {
            for (const s of FALLBACK_STATIONS) {
                bySystem[s.system] = (bySystem[s.system] ?? 0) + 1;
            }
            return {
                activeCount: FALLBACK_TOTAL,
                total: FALLBACK_TOTAL,
                bySystem,
            };
        }

        let activeCount = 0;
        for (const s of FALLBACK_STATIONS) {
            if (
                turf.booleanPointInPolygon(
                    turf.point([s.lng, s.lat]),
                    $territory,
                )
            ) {
                activeCount++;
                bySystem[s.system] = (bySystem[s.system] ?? 0) + 1;
            }
        }
        return { activeCount, total: FALLBACK_TOTAL, bySystem };
    }, [$territory, hasLiveStations]);

    const byOperator = useMemo(
        () => (hasLiveStations ? countByOperator($trainStations) : {}),
        [$trainStations, hasLiveStations],
    );

    const activeCount = hasLiveStations
        ? liveCount
        : (fallback?.activeCount ?? 0);
    const total = hasLiveStations
        ? Math.max($baseline ?? liveCount, liveCount)
        : (fallback?.total ?? 0);
    const breakdown = hasLiveStations ? byOperator : (fallback?.bySystem ?? {});

    const pct = total > 0 ? activeCount / total : 0;
    const eliminated = Math.max(total - activeCount, 0);

    const countColor =
        pct > 0.5
            ? "text-emerald-400"
            : pct > 0.2
              ? "text-yellow-400"
              : "text-red-400";

    const barColor =
        pct > 0.5
            ? "bg-emerald-500"
            : pct > 0.2
              ? "bg-yellow-500"
              : "bg-red-500";

    // Only show rows that still have stations remaining, largest first. More
    // than five networks would crowd the panel, so the tail is summed into one
    // row — otherwise the breakdown silently fails to add up to the headline.
    const allRows = Object.entries(breakdown)
        .filter(([, n]) => n > 0)
        .sort(([, a], [, b]) => b - a);
    const rows = allRows.slice(0, 5);
    const otherCount = allRows.slice(5).reduce((total, [, n]) => total + n, 0);

    return (
        <div className="rounded-xl bg-black/80 px-3 py-2 shadow-lg backdrop-blur-sm select-none min-w-[200px]">
            {/* Header */}
            <div className="flex items-baseline justify-between gap-3 mb-1">
                <span className="text-xs font-medium text-white/60 tracking-wide uppercase">
                    {hasLiveStations ? "Hiding stations" : "Rail + Subway"}
                </span>
                <span className="text-xs text-white/50">
                    −{eliminated.toLocaleString()} eliminated
                </span>
            </div>

            {/* Big count */}
            <div className="flex items-baseline gap-1.5">
                <span
                    className={cn(
                        "text-2xl font-bold tabular-nums leading-none",
                        countColor,
                    )}
                >
                    {activeCount.toLocaleString()}
                </span>
                <span className="text-sm text-white/60">
                    / {total.toLocaleString()} stations
                </span>
            </div>

            {/* Progress bar */}
            <div className="mt-2 h-1.5 w-full rounded-full bg-white/10">
                <div
                    className={cn(
                        "h-full rounded-full transition-all duration-500",
                        barColor,
                    )}
                    style={{
                        width:
                            activeCount === 0
                                ? "0%"
                                : `${Math.max(pct * 100, 1)}%`,
                    }}
                />
            </div>

            {!hasLiveStations && (
                <div className="mt-2 border-t border-white/10 pt-1.5 text-[11px] text-white/60">
                    Reference list — open hiding zones for the live count
                </div>
            )}

            {/* Per-operator (live) or per-system (fallback) breakdown */}
            {(rows.length > 0 || otherCount > 0) && (
                <div className="mt-2 space-y-0.5 border-t border-white/10 pt-1.5">
                    {rows.map(([key, n]) => (
                        <div
                            key={key}
                            className="flex justify-between gap-3 text-[11px] text-white/50"
                        >
                            <span className="truncate">
                                {/* SYSTEM_LABEL describes the bundled list —
                                    its "Subway" entry is the curated
                                    major-stations set. Live keys are OSM
                                    network tags and must not borrow those
                                    labels, or an untagged-subway group would
                                    be captioned "(major only)" when it is
                                    nothing of the sort. */}
                                {hasLiveStations
                                    ? key
                                    : (SYSTEM_LABEL[key] ?? key)}
                            </span>
                            <span className="tabular-nums shrink-0">{n}</span>
                        </div>
                    ))}
                    {otherCount > 0 && (
                        <div className="flex justify-between gap-3 text-[11px] text-white/50">
                            <span className="truncate">
                                Other networks ({allRows.length - rows.length})
                            </span>
                            <span className="tabular-nums shrink-0">
                                {otherCount}
                            </span>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};
