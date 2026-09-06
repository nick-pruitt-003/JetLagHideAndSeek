/**
 * Map overlay colours, chosen to satisfy WCAG 2.1 AA.
 *
 * Relevant success criteria:
 *   * 1.4.11 Non-text Contrast — graphical objects needed to understand the
 *     content must reach 3:1 against adjacent colours. The playable/eliminated
 *     boundary and the wash over eliminated ground both qualify.
 *   * 1.4.3 Contrast (Minimum) — text at 4.5:1, which the station panel's
 *     labels must clear.
 *
 * The measured ratios are pinned in tests/mapContrast.test.ts, so changing a
 * colour here fails the suite rather than quietly regressing the map.
 */

/** CARTO dark ground colour, sampled from dark-matter / CARTO Dark tiles. */
export const DARK_BASEMAP_GROUND = "#0e1013";
/** CARTO Voyager / Positron ground colour. */
export const LIGHT_BASEMAP_GROUND = "#f2efe9";

/**
 * Overlays sit on whatever the basemap draws, not on flat paper, and the newer
 * options are far more colourful than CARTO's muted styles. These are sampled
 * from real tiles and are what the palette has to clear — the salmon arterial
 * in Thunderforest Transport is the hardest case in both themes.
 */
export const LIGHT_BASEMAP_SAMPLES = {
    paper: LIGHT_BASEMAP_GROUND,
    building: "#e6ded2",
    yellowStreet: "#f5e79e",
    salmonArterial: "#c0736a",
} as const;

export const DARK_BASEMAP_SAMPLES = {
    cartoDark: DARK_BASEMAP_GROUND,
    thunderforestDark: "#2b2b33",
    thunderforestDarkRoad: "#4a4a57",
} as const;

/**
 * Is this basemap a dark cartography?
 *
 * Covers both shapes the picker uses: "dark"/"dark-vector" (CARTO Dark Matter)
 * and "transport-dark-vector" (Thunderforest). Shared so the map mask and the
 * hiding-zone palette can never disagree about which theme is on screen.
 */
export const isDarkBasemap = (tileLayer: string) =>
    tileLayer.startsWith("dark") || tileLayer.includes("-dark");

export const MAP_CONTRAST = {
    /** Outline between in-play and eliminated ground. */
    darkBoundary: "#f8fafc",
    lightBoundary: "#0f172a",

    /**
     * Wash over eliminated ground. Dark mode fogs *lighter* rather than
     * darker: against a near-black basemap, no amount of darkening reaches
     * 3:1 (black at 0.82 opacity measures 1.08:1).
     *
     * Both washes are achromatic. A navy wash (#0f172a) threw a purple cast
     * over warm cartography and still only managed 2.32:1 against a salmon
     * arterial; neutral black at 0.55 clears every sampled ground.
     */
    darkWash: "#e2e8f0",
    darkWashOpacity: 0.5,
    lightWash: "#000000",
    lightWashOpacity: 0.55,

    /**
     * Hiding-zone circles. The stroke is the graphic that has to clear 3:1 —
     * plain green (#008000) manages only 1.44:1 against a salmon arterial, so
     * light basemaps take a much darker green and keep the familiar green fill
     * underneath it.
     */
    zoneStrokeDark: "#4ade80",
    zoneFillDark: "#22c55e",
    zoneStrokeLight: "#052e16",
    zoneFillLight: "green",

    /**
     * Station markers are small glyphs over arbitrary cartography, where no
     * single colour can be guaranteed to contrast. They get a halo of the
     * opposite lightness instead, so an edge always separates glyph from map.
     */
    markerHaloDark: "#0b0f14",
    markerHaloLight: "#ffffff",

    /** Citi Bike dock pins. #1d4ed8 only manages 2.84:1 on dark ground. */
    citiBikePinDark: "#3b82f6",
    citiBikePinLight: "#1d4ed8",
} as const;
