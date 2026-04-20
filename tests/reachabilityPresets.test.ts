import { describe, expect, it } from "vitest";

import { resolveDeparturePreset } from "@/components/ReachabilitySection";

describe("resolveDeparturePreset", () => {
    it("returns 'now' verbatim", () => {
        const now = new Date("2026-04-20T14:30:00Z");
        const d = resolveDeparturePreset("now", "", now);
        expect(d).not.toBeNull();
        expect(d!.getTime()).toBe(now.getTime());
    });

    it("weekday-9am on a Monday before 9 picks today", () => {
        // Monday 2026-04-20T08:00 local (ctor is local-interpreted when
        // given Y/M/D numeric args).
        const mondayEarly = new Date(2026, 3, 20, 8, 0, 0);
        const d = resolveDeparturePreset("weekday-9am", "", mondayEarly);
        expect(d).not.toBeNull();
        expect(d!.getDay()).toBe(1); // Monday
        expect(d!.getHours()).toBe(9);
        expect(d!.getDate()).toBe(20);
    });

    it("weekday-9am on a Monday after 9 picks Tuesday", () => {
        const mondayLate = new Date(2026, 3, 20, 10, 0, 0);
        const d = resolveDeparturePreset("weekday-9am", "", mondayLate);
        expect(d).not.toBeNull();
        expect(d!.getDay()).toBe(2); // Tuesday
        expect(d!.getDate()).toBe(21);
        expect(d!.getHours()).toBe(9);
    });

    it("weekday-9am on a Saturday skips to Monday", () => {
        // Saturday 2026-04-25
        const saturday = new Date(2026, 3, 25, 10, 0, 0);
        const d = resolveDeparturePreset("weekday-9am", "", saturday);
        expect(d).not.toBeNull();
        expect(d!.getDay()).toBe(1);
        expect(d!.getDate()).toBe(27);
    });

    it("saturday-noon on a Friday picks the following Saturday", () => {
        // Friday 2026-04-24
        const friday = new Date(2026, 3, 24, 10, 0, 0);
        const d = resolveDeparturePreset("saturday-noon", "", friday);
        expect(d).not.toBeNull();
        expect(d!.getDay()).toBe(6);
        expect(d!.getHours()).toBe(12);
    });

    it("tonight-6pm before 6 picks tonight", () => {
        const now = new Date(2026, 3, 20, 14, 0, 0);
        const d = resolveDeparturePreset("tonight-6pm", "", now);
        expect(d).not.toBeNull();
        expect(d!.getDate()).toBe(20);
        expect(d!.getHours()).toBe(18);
    });

    it("tonight-6pm after 6 rolls to tomorrow", () => {
        const now = new Date(2026, 3, 20, 19, 0, 0);
        const d = resolveDeparturePreset("tonight-6pm", "", now);
        expect(d).not.toBeNull();
        expect(d!.getDate()).toBe(21);
        expect(d!.getHours()).toBe(18);
    });

    it("custom parses ISO strings", () => {
        const d = resolveDeparturePreset("custom", "2026-05-01T12:00:00Z");
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe("2026-05-01T12:00:00.000Z");
    });

    it("custom returns null on empty", () => {
        expect(resolveDeparturePreset("custom", "")).toBeNull();
    });

    it("custom returns null on garbage", () => {
        expect(resolveDeparturePreset("custom", "not a date")).toBeNull();
    });
});
