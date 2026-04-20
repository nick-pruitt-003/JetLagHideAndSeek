// Serialization helpers for the reachability portion of the shared
// hiding-zone payload (?hzc= URL param, clipboard, pastebin).
//
// Design notes:
// - We only emit fields that deviate from their in-app defaults. A sharer
//   who has never touched the reachability panel will produce no
//   reachability block at all, keeping legacy share URLs byte-for-byte
//   unchanged.
// - `version: 1` lets us evolve the schema later without breaking old
//   URLs. The parser refuses any other version number and the
//   container (the hiding-zone loader) simply skips restore.
// - Runtime reachability *results* (arrival times, classifications) are
//   intentionally NOT serialized: the result Map can be tens of
//   thousands of entries and is cheap to recompute once the guest hits
//   "Compute reachability" after loading the share.

import type { ReachabilityDeparturePreset } from "@/lib/context";

export interface ReachabilityPayloadV1 {
    version: 1;
    budgetMinutes?: number;
    walkSpeedMph?: number;
    maxWalkLegMinutes?: number;
    departurePreset?: ReachabilityDeparturePreset;
    departureCustomISO?: string;
    selectedSystemIds?: string[];
    overrides?: Record<string, "include" | "exclude">;
}

export interface ReachabilityShareState {
    budgetMinutes: number;
    walkSpeedMph: number;
    maxWalkLegMinutes: number;
    departurePreset: ReachabilityDeparturePreset;
    departureCustomISO: string;
    selectedSystemIds: string[];
    overrides: Record<string, "include" | "exclude">;
}

// Must match the defaults declared on the persistent atoms in
// `src/lib/context.ts`. Keep these in sync — the reachability-payload
// test exercises that end-to-end, but a mismatch would silently bloat
// share URLs for users who never customized anything.
export const REACHABILITY_DEFAULTS: Omit<
    ReachabilityShareState,
    "selectedSystemIds" | "overrides"
> = {
    budgetMinutes: 45,
    walkSpeedMph: 3,
    maxWalkLegMinutes: 20,
    departurePreset: "now",
    departureCustomISO: "",
};

const VALID_PRESETS: ReadonlySet<ReachabilityDeparturePreset> = new Set([
    "now",
    "weekday-9am",
    "saturday-noon",
    "tonight-6pm",
    "custom",
]);

/**
 * Build the reachability share block from the current atom values.
 * Returns `undefined` when everything is at its default so callers can
 * omit the key entirely (keeps legacy share URLs minimal).
 */
export function buildReachabilityPayload(
    state: ReachabilityShareState,
): ReachabilityPayloadV1 | undefined {
    const payload: ReachabilityPayloadV1 = { version: 1 };
    let hasField = false;

    if (state.budgetMinutes !== REACHABILITY_DEFAULTS.budgetMinutes) {
        payload.budgetMinutes = state.budgetMinutes;
        hasField = true;
    }
    if (state.walkSpeedMph !== REACHABILITY_DEFAULTS.walkSpeedMph) {
        payload.walkSpeedMph = state.walkSpeedMph;
        hasField = true;
    }
    if (state.maxWalkLegMinutes !== REACHABILITY_DEFAULTS.maxWalkLegMinutes) {
        payload.maxWalkLegMinutes = state.maxWalkLegMinutes;
        hasField = true;
    }
    if (state.departurePreset !== REACHABILITY_DEFAULTS.departurePreset) {
        payload.departurePreset = state.departurePreset;
        hasField = true;
    }
    if (state.departureCustomISO !== REACHABILITY_DEFAULTS.departureCustomISO) {
        payload.departureCustomISO = state.departureCustomISO;
        hasField = true;
    }
    if (state.selectedSystemIds.length > 0) {
        payload.selectedSystemIds = [...state.selectedSystemIds];
        hasField = true;
    }
    if (Object.keys(state.overrides).length > 0) {
        payload.overrides = { ...state.overrides };
        hasField = true;
    }

    return hasField ? payload : undefined;
}

/**
 * Parse an untrusted blob into a validated reachability payload.
 * Returns `null` for anything that isn't a v1 object — callers should
 * treat `null` as "no reachability block" and leave atoms untouched.
 */
export function parseReachabilityPayload(
    raw: unknown,
): ReachabilityPayloadV1 | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (r.version !== 1) return null;

    const payload: ReachabilityPayloadV1 = { version: 1 };

    if (
        typeof r.budgetMinutes === "number" &&
        isFinite(r.budgetMinutes) &&
        r.budgetMinutes > 0
    ) {
        payload.budgetMinutes = r.budgetMinutes;
    }
    if (
        typeof r.walkSpeedMph === "number" &&
        isFinite(r.walkSpeedMph) &&
        r.walkSpeedMph > 0
    ) {
        payload.walkSpeedMph = r.walkSpeedMph;
    }
    if (
        typeof r.maxWalkLegMinutes === "number" &&
        isFinite(r.maxWalkLegMinutes) &&
        r.maxWalkLegMinutes > 0
    ) {
        payload.maxWalkLegMinutes = r.maxWalkLegMinutes;
    }
    if (
        typeof r.departurePreset === "string" &&
        VALID_PRESETS.has(r.departurePreset as ReachabilityDeparturePreset)
    ) {
        payload.departurePreset =
            r.departurePreset as ReachabilityDeparturePreset;
    }
    if (typeof r.departureCustomISO === "string") {
        payload.departureCustomISO = r.departureCustomISO;
    }
    if (
        Array.isArray(r.selectedSystemIds) &&
        r.selectedSystemIds.every((s) => typeof s === "string")
    ) {
        payload.selectedSystemIds = r.selectedSystemIds as string[];
    }
    if (r.overrides && typeof r.overrides === "object") {
        const valid: Record<string, "include" | "exclude"> = {};
        for (const [k, v] of Object.entries(
            r.overrides as Record<string, unknown>,
        )) {
            if (v === "include" || v === "exclude") {
                valid[k] = v;
            }
        }
        if (Object.keys(valid).length > 0) {
            payload.overrides = valid;
        }
    }

    return payload;
}
