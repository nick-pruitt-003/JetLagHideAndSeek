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
     */
    darkWash: "#cbd5e1",
    darkWashOpacity: 0.45,
    lightWash: "#0f172a",
    lightWashOpacity: 0.5,

    /** Hiding-zone circles. */
    zoneStrokeDark: "#4ade80",
    zoneFillDark: "#22c55e",
    zoneStrokeLight: "green",
    zoneFillLight: "green",

    /** Citi Bike dock pins. #1d4ed8 only manages 2.84:1 on dark ground. */
    citiBikePinDark: "#3b82f6",
    citiBikePinLight: "#1d4ed8",
} as const;
