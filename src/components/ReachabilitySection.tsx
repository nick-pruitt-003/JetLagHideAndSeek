/**
 * Transit reachability controls.
 *
 * Lives inside the ZoneSidebar, renders as a set of SidebarMenuItems so
 * it visually matches the surrounding station-config rows. Computes a
 * ReachabilityResult via the RAPTOR worker and stashes it in the
 * `reachabilityResult` atom; the existing Phase B station filter picks
 * it up from there.
 *
 * Origin is reused from `startingLocation` (the existing game-center
 * marker) — this component never asks the user to re-pick an origin.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useStore } from "@nanostores/react";
import { Loader2, Navigation, Play, RotateCcw, X } from "lucide-react";
import { toast } from "react-toastify";

import {
    reachabilityBudgetMinutes as reachabilityBudgetMinutesAtom,
    reachabilityClassifications as reachabilityClassificationsAtom,
    reachabilityDepartureCustomISO as reachabilityDepartureCustomISOAtom,
    reachabilityDeparturePreset as reachabilityDeparturePresetAtom,
    reachabilityMaxWalkLegMinutes as reachabilityMaxWalkLegMinutesAtom,
    reachabilityOverrides as reachabilityOverridesAtom,
    reachabilityResult as reachabilityResultAtom,
    reachabilitySelectedSystemIds as reachabilitySelectedSystemIdsAtom,
    reachabilityWalkSpeedMph as reachabilityWalkSpeedMphAtom,
    startingLocation as startingLocationAtom,
} from "@/lib/context";
import type { ReachabilityDeparturePreset } from "@/lib/context";
import { listSystems } from "@/lib/transit/gtfs-store";
import { reachabilityClient } from "@/lib/transit/reachability-client";
import type { TransitSystem } from "@/lib/transit/types";

import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { SidebarMenuItem } from "./ui/sidebar-r";
import { cn } from "@/lib/utils";

const MENU_ITEM_CLASSNAME =
    "bg-sidebar-secondary hover:bg-sidebar-secondary p-2 rounded-md";

// ---------------------------------------------------------------------------
// Departure preset resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a preset ID to a concrete Date.
 *
 * Policy:
 *   - "now"            → right now
 *   - "weekday-9am"    → next (or same-day) weekday at 09:00. "Next" means
 *                        "nearest 9am that hasn't passed yet on a Mon-Fri";
 *                        on a Saturday we bump to Monday.
 *   - "saturday-noon"  → next (or same-day) Saturday at 12:00
 *   - "tonight-6pm"    → today at 18:00; if already past, next day.
 *   - "custom"         → parsed from the `customISO` input. Returns null
 *                        if the string is empty or unparseable.
 */
export function resolveDeparturePreset(
    preset: ReachabilityDeparturePreset,
    customISO: string,
    now: Date = new Date(),
): Date | null {
    switch (preset) {
        case "now":
            return new Date(now.getTime());
        case "weekday-9am":
            return nextAt(now, 9, 0, (d) => {
                const dow = d.getDay();
                return dow >= 1 && dow <= 5;
            });
        case "saturday-noon":
            return nextAt(now, 12, 0, (d) => d.getDay() === 6);
        case "tonight-6pm":
            return nextAt(now, 18, 0, () => true);
        case "custom": {
            if (!customISO.trim()) return null;
            const parsed = new Date(customISO);
            if (Number.isNaN(parsed.getTime())) return null;
            return parsed;
        }
    }
}

/**
 * Find the nearest future Date matching `hour:minute` that also satisfies
 * `predicate(date)`. If today already qualifies and the time hasn't
 * passed, use today; otherwise walk forward day-by-day.
 */
function nextAt(
    now: Date,
    hour: number,
    minute: number,
    predicate: (d: Date) => boolean,
): Date {
    for (let offset = 0; offset < 14; offset++) {
        const d = new Date(now);
        d.setDate(d.getDate() + offset);
        d.setHours(hour, minute, 0, 0);
        if (d.getTime() <= now.getTime()) continue;
        if (!predicate(d)) continue;
        return d;
    }
    // Absurdly defensive fallback — predicate rejected 14 days in a row,
    // which none of our built-in predicates can do. Hand back "now" so we
    // still return something.
    return new Date(now.getTime());
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

const PRESET_LABELS: Record<ReachabilityDeparturePreset, string> = {
    "now": "Now",
    "weekday-9am": "Next weekday, 9am",
    "saturday-noon": "Next Saturday, noon",
    "tonight-6pm": "Tonight, 6pm",
    "custom": "Custom…",
};

const PRESET_ORDER: ReachabilityDeparturePreset[] = [
    "now",
    "weekday-9am",
    "saturday-noon",
    "tonight-6pm",
    "custom",
];

/**
 * A stable, order-independent signature of the user's query inputs. Used
 * to tell the user "re-run — your inputs have changed since the last
 * result."
 */
function querySignature(parts: {
    origin: { lat: number; lng: number } | null;
    departureTime: Date | null;
    budgetMinutes: number;
    walkSpeedMph: number;
    maxWalkLegMinutes: number;
    systemIds: string[];
}): string {
    const sortedSystems = [...parts.systemIds].sort().join(",");
    return JSON.stringify({
        o: parts.origin
            ? [
                  Math.round(parts.origin.lat * 1e6),
                  Math.round(parts.origin.lng * 1e6),
              ]
            : null,
        t: parts.departureTime
            ? Math.round(parts.departureTime.getTime() / 60_000) * 60_000
            : null,
        b: parts.budgetMinutes,
        w: parts.walkSpeedMph,
        m: parts.maxWalkLegMinutes,
        s: sortedSystems,
    });
}

function relativeTime(ms: number, now: number = Date.now()): string {
    const deltaSec = Math.round((now - ms) / 1000);
    if (deltaSec < 5) return "just now";
    if (deltaSec < 60) return `${deltaSec}s ago`;
    const deltaMin = Math.round(deltaSec / 60);
    if (deltaMin < 60) return `${deltaMin} min ago`;
    const deltaHr = Math.round(deltaMin / 60);
    if (deltaHr < 24) return `${deltaHr}h ago`;
    return `${Math.round(deltaHr / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ReachabilitySection() {
    const $startingLocation = useStore(startingLocationAtom);
    const $budget = useStore(reachabilityBudgetMinutesAtom);
    const $walkSpeed = useStore(reachabilityWalkSpeedMphAtom);
    const $maxWalkLeg = useStore(reachabilityMaxWalkLegMinutesAtom);
    const $preset = useStore(reachabilityDeparturePresetAtom);
    const $customISO = useStore(reachabilityDepartureCustomISOAtom);
    const $selectedSystems = useStore(reachabilitySelectedSystemIdsAtom);
    const $result = useStore(reachabilityResultAtom);
    const $classifications = useStore(reachabilityClassificationsAtom);
    const $overrides = useStore(reachabilityOverridesAtom);

    const [systems, setSystems] = useState<TransitSystem[] | null>(null);
    const [running, setRunning] = useState(false);
    const [progressMsg, setProgressMsg] = useState<string>("");

    // Load the list of imported systems for the checkbox picker. Re-run
    // when the result changes (new import ➝ worker invalidates ➝ user
    // likely wants to see the new system in the list).
    useEffect(() => {
        let cancelled = false;
        listSystems()
            .then((s) => {
                if (!cancelled) {
                    s.sort((a, b) => a.name.localeCompare(b.name));
                    setSystems(s);
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    console.log("Failed to list systems:", err);
                    setSystems([]);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [$result?.computedAtMs]);

    const origin = useMemo(
        () =>
            $startingLocation === false
                ? null
                : {
                      lat: $startingLocation.latitude,
                      lng: $startingLocation.longitude,
                  },
        [$startingLocation],
    );

    const departureTime = useMemo(
        () => resolveDeparturePreset($preset, $customISO),
        [$preset, $customISO],
    );

    // Effective systems: explicit selection, or all imported if none picked.
    const effectiveSystemIds = useMemo(() => {
        if ($selectedSystems.length > 0) return [...$selectedSystems];
        return systems?.map((s) => s.id) ?? [];
    }, [$selectedSystems, systems]);

    const currentSig = useMemo(
        () =>
            querySignature({
                origin,
                departureTime,
                budgetMinutes: $budget,
                walkSpeedMph: $walkSpeed,
                maxWalkLegMinutes: $maxWalkLeg,
                systemIds: effectiveSystemIds,
            }),
        [
            origin,
            departureTime,
            $budget,
            $walkSpeed,
            $maxWalkLeg,
            effectiveSystemIds,
        ],
    );

    const lastResultSig = useMemo(
        () =>
            $result
                ? querySignature({
                      origin: $result.query.origin,
                      departureTime: $result.query.departureTime,
                      budgetMinutes: $result.query.budgetMinutes,
                      walkSpeedMph: $result.query.walkSpeedMph,
                      maxWalkLegMinutes: $result.query.maxWalkLegMinutes,
                      systemIds: $result.query.systemIds ?? [],
                  })
                : null,
        [$result],
    );

    const isStale = $result !== null && currentSig !== lastResultSig;

    const canRun =
        !running &&
        origin !== null &&
        departureTime !== null &&
        effectiveSystemIds.length > 0 &&
        $budget > 0;

    const runQuery = async () => {
        if (!canRun || !origin || !departureTime) return;
        setRunning(true);
        setProgressMsg("");
        try {
            const result = await reachabilityClient.query(
                {
                    origin,
                    departureTime,
                    budgetMinutes: $budget,
                    walkSpeedMph: $walkSpeed,
                    maxWalkLegMinutes: $maxWalkLeg,
                    systemIds: effectiveSystemIds,
                },
                {
                    onProgress: (msg) => setProgressMsg(msg),
                },
            );
            reachabilityResultAtom.set(result);
            toast.success(
                `Reachability: ${result.arrivalSeconds.size} stops within ${$budget} min`,
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log("Reachability query failed:", err);
            toast.error(`Reachability query failed: ${msg}`, {
                toastId: "reachability-query-error",
                autoClose: 6000,
            });
        } finally {
            setRunning(false);
            setProgressMsg("");
        }
    };

    const clearResult = () => {
        reachabilityResultAtom.set(null);
    };

    const hasSystems = systems !== null && systems.length > 0;

    // Breakdown of the last filter pass. `$classifications` is keyed by
    // OSM id and covers every circle we had at Phase B time; override
    // counts are derived against the current overrides atom.
    const counts = useMemo(() => {
        let reachable = 0;
        let unreachable = 0;
        let unknown = 0;
        let overridesUsed = 0;
        for (const [osmId, status] of $classifications.entries()) {
            if (status === "reachable") reachable++;
            else if (status === "unreachable") unreachable++;
            else unknown++;
            if ($overrides[osmId]) overridesUsed++;
        }
        return { reachable, unreachable, unknown, overridesUsed };
    }, [$classifications, $overrides]);

    const bulkOverrideUnknowns = (decision: "include" | "exclude") => {
        const next = { ...$overrides };
        for (const [osmId, status] of $classifications.entries()) {
            if (status === "unknown") next[osmId] = decision;
        }
        reachabilityOverridesAtom.set(next);
    };

    const clearAllOverrides = () => {
        reachabilityOverridesAtom.set({});
    };

    return (
        <>
            <SidebarMenuItem
                className={cn(
                    MENU_ITEM_CLASSNAME,
                    "flex flex-col items-start gap-1",
                )}
            >
                <div className="flex items-center gap-2 w-full">
                    <Navigation className="h-4 w-4 opacity-80" />
                    <Label className="font-semibold font-poppins">
                        Transit reachability
                    </Label>
                </div>
                <p className="text-xs text-muted-foreground leading-4">
                    Only keep stations you could reach from the starting
                    point by transit within a time budget. Needs at least
                    one imported GTFS feed.
                </p>
            </SidebarMenuItem>

            {/* Origin status */}
            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                <div className="flex flex-col gap-1 w-full text-xs">
                    <span className="font-semibold font-poppins text-sm">
                        Origin
                    </span>
                    {origin ? (
                        <span className="text-muted-foreground">
                            {origin.lat.toFixed(4)}, {origin.lng.toFixed(4)}{" "}
                            <span className="opacity-70">
                                (starting point)
                            </span>
                        </span>
                    ) : (
                        <span className="text-amber-500">
                            Set a starting point on the map to enable
                            reachability.
                        </span>
                    )}
                </div>
            </SidebarMenuItem>

            {/* Departure preset */}
            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                <div className="flex flex-col gap-1.5 w-full">
                    <Label
                        htmlFor="reach-preset"
                        className="font-semibold font-poppins text-sm"
                    >
                        Departure
                    </Label>
                    <select
                        id="reach-preset"
                        value={$preset}
                        onChange={(e) =>
                            reachabilityDeparturePresetAtom.set(
                                e.target.value as ReachabilityDeparturePreset,
                            )
                        }
                        className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                        disabled={running}
                    >
                        {PRESET_ORDER.map((p) => (
                            <option key={p} value={p}>
                                {PRESET_LABELS[p]}
                            </option>
                        ))}
                    </select>
                    {$preset === "custom" && (
                        <Input
                            type="datetime-local"
                            value={toLocalInputValue($customISO)}
                            onChange={(e) =>
                                reachabilityDepartureCustomISOAtom.set(
                                    fromLocalInputValue(e.target.value),
                                )
                            }
                            disabled={running}
                            className="h-8"
                        />
                    )}
                    {departureTime ? (
                        <span className="text-xs text-muted-foreground">
                            = {departureTime.toLocaleString()}
                        </span>
                    ) : (
                        <span className="text-xs text-amber-500">
                            Pick a valid date & time.
                        </span>
                    )}
                </div>
            </SidebarMenuItem>

            {/* Budget */}
            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                <div className="flex items-center justify-between gap-2 w-full">
                    <Label
                        htmlFor="reach-budget"
                        className="font-semibold font-poppins text-sm"
                    >
                        Budget (minutes)
                    </Label>
                    <Input
                        id="reach-budget"
                        type="number"
                        min={1}
                        max={480}
                        step={5}
                        value={$budget}
                        onChange={(e) => {
                            const n = Number(e.target.value);
                            if (!Number.isNaN(n) && n > 0) {
                                reachabilityBudgetMinutesAtom.set(n);
                            }
                        }}
                        disabled={running}
                        className="h-8 w-20 text-right"
                    />
                </div>
            </SidebarMenuItem>

            {/* Walk speed */}
            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                <div className="flex items-center justify-between gap-2 w-full">
                    <Label
                        htmlFor="reach-walk-speed"
                        className="font-semibold font-poppins text-sm"
                    >
                        Walk speed (mph)
                    </Label>
                    <Input
                        id="reach-walk-speed"
                        type="number"
                        min={1}
                        max={8}
                        step={0.1}
                        value={$walkSpeed}
                        onChange={(e) => {
                            const n = Number(e.target.value);
                            if (!Number.isNaN(n) && n > 0) {
                                reachabilityWalkSpeedMphAtom.set(n);
                            }
                        }}
                        disabled={running}
                        className="h-8 w-20 text-right"
                    />
                </div>
            </SidebarMenuItem>

            {/* Max single walk leg */}
            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                <div className="flex items-center justify-between gap-2 w-full">
                    <Label
                        htmlFor="reach-max-walk"
                        className="font-semibold font-poppins text-sm leading-4"
                    >
                        Max single walk (min)
                    </Label>
                    <Input
                        id="reach-max-walk"
                        type="number"
                        min={1}
                        max={120}
                        step={1}
                        value={$maxWalkLeg}
                        onChange={(e) => {
                            const n = Number(e.target.value);
                            if (!Number.isNaN(n) && n > 0) {
                                reachabilityMaxWalkLegMinutesAtom.set(n);
                            }
                        }}
                        disabled={running}
                        className="h-8 w-20 text-right"
                    />
                </div>
            </SidebarMenuItem>

            {/* System picker */}
            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                <div className="flex flex-col gap-1.5 w-full">
                    <Label className="font-semibold font-poppins text-sm">
                        Systems
                    </Label>
                    {systems === null ? (
                        <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Loading…
                        </span>
                    ) : systems.length === 0 ? (
                        <span className="text-xs text-amber-500">
                            No transit feeds imported. Open “Manage transit
                            systems…” above.
                        </span>
                    ) : (
                        <div className="flex flex-col gap-1">
                            {systems.map((s) => {
                                const explicitlyPicked =
                                    $selectedSystems.includes(s.id);
                                const effectivelyPicked =
                                    $selectedSystems.length === 0
                                        ? true
                                        : explicitlyPicked;
                                return (
                                    <label
                                        key={s.id}
                                        className="flex items-center gap-2 text-xs cursor-pointer"
                                    >
                                        <Checkbox
                                            checked={effectivelyPicked}
                                            onCheckedChange={(v) => {
                                                const next = new Set(
                                                    $selectedSystems,
                                                );
                                                if (v) {
                                                    // If nothing was
                                                    // explicitly picked
                                                    // (all-effective), a
                                                    // tick is a no-op on
                                                    // this row but we
                                                    // initialize the set
                                                    // from the full list
                                                    // so the OTHER rows
                                                    // can be unticked.
                                                    if (
                                                        $selectedSystems.length ===
                                                        0
                                                    ) {
                                                        for (const r of systems) {
                                                            next.add(r.id);
                                                        }
                                                    }
                                                    next.add(s.id);
                                                } else {
                                                    // Turning off when
                                                    // the list was
                                                    // effectively-all
                                                    // needs the same
                                                    // materialization.
                                                    if (
                                                        $selectedSystems.length ===
                                                        0
                                                    ) {
                                                        for (const r of systems) {
                                                            next.add(r.id);
                                                        }
                                                    }
                                                    next.delete(s.id);
                                                }
                                                // If the resulting set
                                                // covers everything, go
                                                // back to the
                                                // "effectively-all" empty
                                                // state so we track
                                                // future imports
                                                // automatically.
                                                if (
                                                    next.size ===
                                                        systems.length &&
                                                    [...next].every((id) =>
                                                        systems.some(
                                                            (r) =>
                                                                r.id === id,
                                                        ),
                                                    )
                                                ) {
                                                    reachabilitySelectedSystemIdsAtom.set(
                                                        [],
                                                    );
                                                } else {
                                                    reachabilitySelectedSystemIdsAtom.set(
                                                        [...next],
                                                    );
                                                }
                                            }}
                                            disabled={running}
                                        />
                                        <span className="truncate">
                                            {s.name}
                                        </span>
                                    </label>
                                );
                            })}
                        </div>
                    )}
                </div>
            </SidebarMenuItem>

            {/* Run + result summary */}
            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                <div className="flex flex-col gap-2 w-full">
                    <div className="flex gap-2">
                        <Button
                            onClick={runQuery}
                            disabled={!canRun || !hasSystems}
                            className="flex-1"
                        >
                            {running ? (
                                <>
                                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                                    Running…
                                </>
                            ) : $result ? (
                                <>
                                    <RotateCcw className="h-4 w-4 mr-1.5" />
                                    {isStale ? "Re-run" : "Run again"}
                                </>
                            ) : (
                                <>
                                    <Play className="h-4 w-4 mr-1.5" />
                                    Run reachability
                                </>
                            )}
                        </Button>
                        {$result && (
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={clearResult}
                                disabled={running}
                                aria-label="Clear reachability filter"
                            >
                                <X className="h-4 w-4" />
                            </Button>
                        )}
                    </div>
                    {running && progressMsg && (
                        <span className="text-xs text-muted-foreground">
                            {progressMsg}
                        </span>
                    )}
                    {$result && !running && (
                        <span
                            className={cn(
                                "text-xs",
                                isStale
                                    ? "text-amber-500"
                                    : "text-muted-foreground",
                            )}
                        >
                            {isStale
                                ? "Inputs changed — re-run to refresh."
                                : `Active · ${$result.arrivalSeconds.size.toLocaleString()} reachable stops · ${relativeTime(
                                      $result.computedAtMs,
                                  )}`}
                        </span>
                    )}
                </div>
            </SidebarMenuItem>

            {/*
              Classification breakdown + bulk override actions. Only shown
              when we actually have classifications — i.e. reachability
              has been queried AND Phase B has run at least once.
            */}
            {$result && $classifications.size > 0 && (
                <SidebarMenuItem
                    className={cn(
                        MENU_ITEM_CLASSNAME,
                        "flex flex-col items-start gap-2",
                    )}
                >
                    <Label className="font-semibold font-poppins text-sm">
                        Station breakdown
                    </Label>
                    <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
                        <span>
                            <span className="text-green-500">
                                ✓ {counts.reachable.toLocaleString()}
                            </span>{" "}
                            reachable
                        </span>
                        <span>
                            <span className="text-amber-500">
                                ? {counts.unknown.toLocaleString()}
                            </span>{" "}
                            unknown
                        </span>
                        <span>
                            <span className="text-red-500">
                                ✗ {counts.unreachable.toLocaleString()}
                            </span>{" "}
                            unreachable
                        </span>
                        {counts.overridesUsed > 0 && (
                            <span>
                                ·{" "}
                                {counts.overridesUsed.toLocaleString()}{" "}
                                overridden
                            </span>
                        )}
                    </div>
                    {counts.unknown > 0 && (
                        <div className="flex gap-1.5 flex-wrap">
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={() =>
                                    bulkOverrideUnknowns("include")
                                }
                                disabled={running}
                            >
                                Include all unknown
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={() =>
                                    bulkOverrideUnknowns("exclude")
                                }
                                disabled={running}
                            >
                                Exclude all unknown
                            </Button>
                        </div>
                    )}
                    {counts.overridesUsed > 0 && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs text-muted-foreground"
                            onClick={clearAllOverrides}
                            disabled={running}
                        >
                            Clear all overrides
                        </Button>
                    )}
                </SidebarMenuItem>
            )}
        </>
    );
}

// ---------------------------------------------------------------------------
// <input type="datetime-local"> value conversion
// ---------------------------------------------------------------------------

/**
 * ISO string (UTC) → value the `datetime-local` input wants (local, no
 * timezone suffix). Empty string in, empty string out.
 */
function toLocalInputValue(iso: string): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
        d.getDate(),
    )}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * `datetime-local` value (local, no timezone) → ISO string. The input is
 * interpreted as the user's local time.
 */
function fromLocalInputValue(local: string): string {
    if (!local) return "";
    const d = new Date(local);
    if (Number.isNaN(d.getTime())) return "";
    return d.toISOString();
}
