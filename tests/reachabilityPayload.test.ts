import { describe, expect, it } from "vitest";

import {
    buildReachabilityPayload,
    parseReachabilityPayload,
    REACHABILITY_DEFAULTS,
    type ReachabilityShareState,
} from "@/lib/share/reachability-payload";

const DEFAULT_STATE: ReachabilityShareState = {
    budgetMinutes: REACHABILITY_DEFAULTS.budgetMinutes,
    walkSpeedMph: REACHABILITY_DEFAULTS.walkSpeedMph,
    maxWalkLegMinutes: REACHABILITY_DEFAULTS.maxWalkLegMinutes,
    departurePreset: REACHABILITY_DEFAULTS.departurePreset,
    departureCustomISO: REACHABILITY_DEFAULTS.departureCustomISO,
    selectedSystemIds: [],
    overrides: {},
};

describe("buildReachabilityPayload", () => {
    it("returns undefined when every field is at its default", () => {
        expect(buildReachabilityPayload(DEFAULT_STATE)).toBeUndefined();
    });

    it("omits default-valued fields but keeps the changed ones", () => {
        const payload = buildReachabilityPayload({
            ...DEFAULT_STATE,
            budgetMinutes: 90,
        });
        expect(payload).toEqual({ version: 1, budgetMinutes: 90 });
    });

    it("serializes every non-default field together", () => {
        const payload = buildReachabilityPayload({
            budgetMinutes: 30,
            walkSpeedMph: 4,
            maxWalkLegMinutes: 10,
            departurePreset: "weekday-9am",
            departureCustomISO: "2024-06-01T09:00:00.000Z",
            selectedSystemIds: ["nyct-subway", "lirr"],
            overrides: { "node/123": "include", "node/456": "exclude" },
        });
        expect(payload).toEqual({
            version: 1,
            budgetMinutes: 30,
            walkSpeedMph: 4,
            maxWalkLegMinutes: 10,
            departurePreset: "weekday-9am",
            departureCustomISO: "2024-06-01T09:00:00.000Z",
            selectedSystemIds: ["nyct-subway", "lirr"],
            overrides: { "node/123": "include", "node/456": "exclude" },
        });
    });

    it("defensively clones arrays and objects so callers can't mutate the state", () => {
        const systems = ["nyct-subway"];
        const overrides: Record<string, "include" | "exclude"> = {
            "node/123": "include",
        };
        const payload = buildReachabilityPayload({
            ...DEFAULT_STATE,
            selectedSystemIds: systems,
            overrides,
        });
        systems.push("lirr");
        overrides["node/456"] = "include";
        expect(payload?.selectedSystemIds).toEqual(["nyct-subway"]);
        expect(payload?.overrides).toEqual({ "node/123": "include" });
    });
});

describe("parseReachabilityPayload", () => {
    it("rejects anything that isn't a v1 object", () => {
        expect(parseReachabilityPayload(null)).toBeNull();
        expect(parseReachabilityPayload(undefined)).toBeNull();
        expect(parseReachabilityPayload("nope")).toBeNull();
        expect(parseReachabilityPayload({})).toBeNull();
        expect(parseReachabilityPayload({ version: 2 })).toBeNull();
    });

    it("passes through a well-formed payload", () => {
        const raw = {
            version: 1,
            budgetMinutes: 30,
            walkSpeedMph: 4,
            maxWalkLegMinutes: 10,
            departurePreset: "saturday-noon",
            departureCustomISO: "",
            selectedSystemIds: ["nyct-subway"],
            overrides: { "node/123": "include", "node/456": "exclude" },
        };
        expect(parseReachabilityPayload(raw)).toEqual(raw);
    });

    it("drops numeric fields that aren't positive finite numbers", () => {
        expect(
            parseReachabilityPayload({
                version: 1,
                budgetMinutes: -5,
                walkSpeedMph: Infinity,
                maxWalkLegMinutes: "10",
            }),
        ).toEqual({ version: 1 });
    });

    it("rejects an unknown departure preset but preserves the custom ISO", () => {
        const parsed = parseReachabilityPayload({
            version: 1,
            departurePreset: "made-up",
            departureCustomISO: "2024-06-01T09:00:00.000Z",
        });
        expect(parsed?.departurePreset).toBeUndefined();
        expect(parsed?.departureCustomISO).toBe("2024-06-01T09:00:00.000Z");
    });

    it("drops non-string entries from selectedSystemIds", () => {
        expect(
            parseReachabilityPayload({
                version: 1,
                selectedSystemIds: ["nyct-subway", 42, null],
            }),
        ).toEqual({ version: 1 });
    });

    it("filters junk out of overrides but keeps valid pairs", () => {
        const parsed = parseReachabilityPayload({
            version: 1,
            overrides: {
                "node/123": "include",
                "node/456": "exclude",
                "node/789": "maybe",
                "node/000": null,
            },
        });
        expect(parsed?.overrides).toEqual({
            "node/123": "include",
            "node/456": "exclude",
        });
    });

    it("omits overrides entirely when nothing survives validation", () => {
        const parsed = parseReachabilityPayload({
            version: 1,
            overrides: { "node/123": "maybe" },
        });
        expect(parsed).toEqual({ version: 1 });
    });
});

describe("buildReachabilityPayload ↔ parseReachabilityPayload round trip", () => {
    it("survives JSON encode/decode through the helpers", () => {
        const state: ReachabilityShareState = {
            budgetMinutes: 75,
            walkSpeedMph: 2.5,
            maxWalkLegMinutes: 15,
            departurePreset: "custom",
            departureCustomISO: "2024-07-04T14:30:00.000Z",
            selectedSystemIds: ["nyct-subway", "njt-rail"],
            overrides: { "node/1": "include", "node/2": "exclude" },
        };
        const built = buildReachabilityPayload(state);
        const serialized = JSON.stringify(built);
        const parsed = parseReachabilityPayload(JSON.parse(serialized));
        expect(parsed).toEqual(built);
    });
});
