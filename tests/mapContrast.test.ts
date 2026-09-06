import { describe, expect, it } from "vitest";

import {
    AA_NON_TEXT,
    AA_TEXT,
    contrastRatio,
    flatten,
    parseHex,
    relativeLuminance,
} from "@/lib/contrast";
import {
    DARK_BASEMAP_GROUND,
    LIGHT_BASEMAP_GROUND,
    MAP_CONTRAST,
} from "@/lib/map-contrast";

/** The station panel sits on bg-black/80 over the map. */
const PANEL = flatten("#000000", 0.8, DARK_BASEMAP_GROUND);
const panelText = (alpha: number) =>
    contrastRatio(flatten("#ffffff", alpha, "#0b0c0e"), PANEL);

describe("contrast maths", () => {
    it("matches the WCAG reference extremes", () => {
        expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
        expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
        expect(relativeLuminance(parseHex("#ffffff"))).toBeCloseTo(1, 5);
        expect(relativeLuminance(parseHex("#000000"))).toBeCloseTo(0, 5);
    });

    it("accepts shorthand hex", () => {
        expect(parseHex("#fff")).toEqual([255, 255, 255]);
    });
});

describe("elimination mask meets WCAG 1.4.11", () => {
    it("outlines the boundary at 3:1 or better in both themes", () => {
        expect(
            contrastRatio(
                flatten(MAP_CONTRAST.darkBoundary, 0.85, DARK_BASEMAP_GROUND),
                DARK_BASEMAP_GROUND,
            ),
        ).toBeGreaterThanOrEqual(AA_NON_TEXT);

        expect(
            contrastRatio(
                flatten(MAP_CONTRAST.lightBoundary, 0.7, LIGHT_BASEMAP_GROUND),
                LIGHT_BASEMAP_GROUND,
            ),
        ).toBeGreaterThanOrEqual(AA_NON_TEXT);
    });

    it("separates eliminated ground from in-play ground at 3:1 or better", () => {
        expect(
            contrastRatio(
                flatten(
                    MAP_CONTRAST.darkWash,
                    MAP_CONTRAST.darkWashOpacity,
                    DARK_BASEMAP_GROUND,
                ),
                DARK_BASEMAP_GROUND,
            ),
        ).toBeGreaterThanOrEqual(AA_NON_TEXT);

        expect(
            contrastRatio(
                flatten(
                    MAP_CONTRAST.lightWash,
                    MAP_CONTRAST.lightWashOpacity,
                    LIGHT_BASEMAP_GROUND,
                ),
                LIGHT_BASEMAP_GROUND,
            ),
        ).toBeGreaterThanOrEqual(AA_NON_TEXT);
    });

    it("documents why dark mode fogs lighter instead of darker", () => {
        // The instinct is to darken eliminated ground. Against a near-black
        // basemap that cannot clear the bar at any opacity — this is the
        // measurement that drove the design.
        const darkened = contrastRatio(
            flatten("#000000", 0.82, DARK_BASEMAP_GROUND),
            DARK_BASEMAP_GROUND,
        );
        expect(darkened).toBeLessThan(AA_NON_TEXT);
        expect(darkened).toBeLessThan(1.5);
    });
});

describe("map markers meet WCAG 1.4.11", () => {
    it("draws hiding-zone circles at 3:1 or better", () => {
        expect(
            contrastRatio(MAP_CONTRAST.zoneStrokeDark, DARK_BASEMAP_GROUND),
        ).toBeGreaterThanOrEqual(AA_NON_TEXT);
        expect(
            contrastRatio("#008000", LIGHT_BASEMAP_GROUND),
        ).toBeGreaterThanOrEqual(AA_NON_TEXT);
    });

    it("draws Citi Bike pins at 3:1 or better", () => {
        expect(
            contrastRatio(MAP_CONTRAST.citiBikePinDark, DARK_BASEMAP_GROUND),
        ).toBeGreaterThanOrEqual(AA_NON_TEXT);
        expect(
            contrastRatio(MAP_CONTRAST.citiBikePinLight, LIGHT_BASEMAP_GROUND),
        ).toBeGreaterThanOrEqual(AA_NON_TEXT);
    });

    it("rejects the old pin colour that failed on dark", () => {
        expect(contrastRatio("#1d4ed8", DARK_BASEMAP_GROUND)).toBeLessThan(
            AA_NON_TEXT,
        );
    });
});

describe("station panel text meets WCAG 1.4.3", () => {
    it("clears 4.5:1 for every opacity the panel uses", () => {
        for (const alpha of [0.5, 0.6]) {
            expect(panelText(alpha)).toBeGreaterThanOrEqual(AA_TEXT);
        }
    });

    it("rejects the white/40 hint that failed", () => {
        expect(panelText(0.4)).toBeLessThan(AA_TEXT);
    });

    it("keeps the count colours readable", () => {
        for (const color of ["#f87171", "#facc15", "#4ade80"]) {
            expect(contrastRatio(color, PANEL)).toBeGreaterThanOrEqual(AA_TEXT);
        }
    });
});
