/**
 * CARTO vector basemap rendered by MapLibre GL inside the existing Leaflet map.
 *
 * CARTO is retiring its raster tiles in favor of vector ones, so this is the
 * forward path for the Voyager / Light / Dark styles. It is deliberately
 * additive: the raster layers in `Map.tsx` stay the default, and this component
 * only mounts when a `*-vector` style is picked.
 *
 * `maplibre-gl` is ~250 KB gzipped, so both it and the Leaflet bridge are
 * imported dynamically — players on the raster styles never download them.
 */

import type { Map as LeafletMap } from "leaflet";
import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import { toast } from "react-toastify";

/** Style keys we expose, mapped to CARTO's GL style bundle names. */
const CARTO_VECTOR_STYLES = {
    voyager: "voyager-gl-style",
    positron: "positron-gl-style",
    "dark-matter": "dark-matter-gl-style",
} as const;

export type CartoVectorStyle = keyof typeof CARTO_VECTOR_STYLES;

/** Thunderforest GL styles. Only some of their maps have a vector version —
 *  Neighbourhood, for one, is raster-only. */
const THUNDERFOREST_VECTOR_STYLES = {
    transport: "transport",
    "transport-dark": "transport-dark",
    landscape: "landscape",
    atlas: "atlas",
} as const;

export type ThunderforestVectorStyle = keyof typeof THUNDERFOREST_VECTOR_STYLES;

const CARTO_ATTRIBUTION =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; &copy; <a href="https://carto.com/attributions">CARTO</a>; Powered by Esri and Turf.js';

/**
 * OpenFreeMap serves OpenMapTiles-schema vector tiles with no key and no rate
 * limit — the closest thing to a vector equivalent of the OSM standard raster
 * style, which has no official GL port.
 */
export const OPENFREEMAP_STYLE_URL =
    "https://tiles.openfreemap.org/styles/liberty";

const OPENFREEMAP_ATTRIBUTION =
    '&copy; <a href="https://openfreemap.org/">OpenFreeMap</a>; &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a>; Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>; Powered by Esri and Turf.js';

const THUNDERFOREST_ATTRIBUTION =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; &copy; <a href="http://www.thunderforest.com/">Thunderforest</a>; Powered by Esri and Turf.js';

export const cartoStyleUrl = (style: CartoVectorStyle, apiKey: string) =>
    `https://basemaps.cartocdn.com/gl/${CARTO_VECTOR_STYLES[style]}/style.json${
        apiKey ? `?key=${encodeURIComponent(apiKey)}` : ""
    }`;

/** Thunderforest bakes the key into the tile/glyph/sprite URLs inside the
 *  style document, so unlike CARTO nothing has to be stamped on afterwards. */
export const thunderforestStyleUrl = (
    style: ThunderforestVectorStyle,
    apiKey: string,
) =>
    `https://api.thunderforest.com/styles/${THUNDERFOREST_VECTOR_STYLES[style]}/style.json?apikey=${encodeURIComponent(apiKey)}`;

/**
 * CARTO enforces the API key on raster today and has said vector is next. The
 * style JSON accepts `?key=` already, and the tile/glyph/sprite URLs it hands
 * back carry no key — so stamp the key onto every CARTO request ourselves
 * rather than betting on which ones will start requiring it.
 */
const cartoTransformRequest =
    (apiKey: string) =>
    (url: string): { url: string } => {
        if (!apiKey || !url.includes(".basemaps.cartocdn.com")) return { url };
        if (/[?&]key=/.test(url)) return { url };

        const separator = url.includes("?") ? "&" : "?";
        return { url: `${url}${separator}key=${encodeURIComponent(apiKey)}` };
    };

export const VectorBasemap = ({
    styleUrl,
    apiKey,
    provider = "carto",
}: {
    styleUrl: string;
    /** Unused by keyless providers; kept so the effect re-runs on key changes. */
    apiKey: string;
    provider?: "carto" | "thunderforest" | "openfreemap";
}) => {
    const map = useMap() as LeafletMap;

    useEffect(() => {
        let cancelled = false;
        let layer: L.Layer | null = null;

        (async () => {
            const attribution =
                provider === "thunderforest"
                    ? THUNDERFOREST_ATTRIBUTION
                    : provider === "openfreemap"
                      ? OPENFREEMAP_ATTRIBUTION
                      : CARTO_ATTRIBUTION;

            try {
                // The Leaflet bridge reads the global `maplibregl` off the
                // module it requires, so both imports have to land before the
                // layer is constructed.
                await import("maplibre-gl/dist/maplibre-gl.css");
                const maplibregl = await import("maplibre-gl");
                await import("@maplibre/maplibre-gl-leaflet");

                // MapLibre derives its worker URL by swapping the filename in
                // its own `import.meta.url`, which resolves to a
                // `_astro/maplibre-gl-worker.mjs` that Vite never emits — a 404
                // that leaves the map with no tiles and no labels at all. Point
                // it at the worker as a real bundled asset instead. Being
                // same-origin also lets the service worker cache what the
                // worker fetches (glyphs and .mvt tiles).
                // `?worker&url` (not a bare `?url`) so Vite bundles the
                // worker together with its relative `maplibre-gl-shared.mjs`
                // import — emitting the bare file leaves that dependency
                // unresolved and the worker dies on load.
                const workerUrl = (
                    await import("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url")
                ).default;
                maplibregl.setWorkerUrl(workerUrl);

                // The style changed (or the map unmounted) while we were
                // fetching the chunk — whatever we build now is stale.
                if (cancelled) return;

                layer = L.maplibreGL({
                    style: styleUrl,
                    // Attribution is a licence requirement for every provider
                    // here (OSM data, plus CARTO/Thunderforest/OpenMapTiles
                    // terms), and it needs `attributionControl`, NOT the usual
                    // Leaflet `attribution` option: the bridge overrides
                    // getAttribution() to read
                    // `options.attributionControl.customAttribution`, falling
                    // back to whatever the GL style's sources happen to
                    // declare. CARTO's style declares its own, so `attribution`
                    // appeared to work; OpenFreeMap's does not, and the credit
                    // silently vanished.
                    attributionControl: { customAttribution: attribution },
                    // `pointer-events: none` on the canvas — every click still
                    // reaches Leaflet, so contextmenu, draw and pick mode are
                    // unaffected.
                    interactive: false,
                    // leaflet-easyprint screenshots the DOM via
                    // `canvas.toDataURL()`, which returns a transparent image
                    // for a WebGL canvas unless the drawing buffer is kept.
                    // Without this the basemap prints blank. MapLibre 5 moved
                    // the WebGL context attributes here from the top level,
                    // where the option is now silently ignored.
                    canvasContextAttributes: { preserveDrawingBuffer: true },
                    transformRequest:
                        provider === "carto"
                            ? cartoTransformRequest(apiKey)
                            : undefined,
                } as any);

                layer!.addTo(map);

                const glMap = (layer as any).getMaplibreMap?.();
                glMap?.on("webglcontextlost", () => {
                    // Backgrounding the tab on a phone can cost the GL context,
                    // which blanks the basemap until reload. The overlays are
                    // SVG and survive, so say what happened rather than leaving
                    // an empty map.
                    toast.error(
                        "Map rendering was interrupted. Reload, or switch to a raster basemap in Options.",
                        { toastId: "webgl-context-lost" },
                    );
                });
            } catch (error) {
                if (cancelled) return;
                console.error("Failed to load CARTO vector basemap:", error);
                toast.error(
                    "Couldn't load the vector basemap. Switch to a raster style in Options.",
                    { toastId: "vector-basemap-error" },
                );
            }
        })();

        return () => {
            cancelled = true;
            if (layer) map.removeLayer(layer);
        };
    }, [map, styleUrl, apiKey, provider]);

    return null;
};
