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
export const CARTO_VECTOR_STYLES = {
    voyager: "voyager-gl-style",
    positron: "positron-gl-style",
    "dark-matter": "dark-matter-gl-style",
} as const;

export type CartoVectorStyle = keyof typeof CARTO_VECTOR_STYLES;

const CARTO_ATTRIBUTION =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; &copy; <a href="https://carto.com/attributions">CARTO</a>; Powered by Esri and Turf.js';

const styleUrl = (style: CartoVectorStyle) =>
    `https://basemaps.cartocdn.com/gl/${CARTO_VECTOR_STYLES[style]}/style.json`;

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
    style,
    apiKey,
}: {
    style: CartoVectorStyle;
    apiKey: string;
}) => {
    const map = useMap() as LeafletMap;

    useEffect(() => {
        let cancelled = false;
        let layer: L.Layer | null = null;

        (async () => {
            try {
                // The Leaflet bridge reads the global `maplibregl` off the
                // module it requires, so both imports have to land before the
                // layer is constructed.
                await import("maplibre-gl/dist/maplibre-gl.css");
                await import("maplibre-gl");
                await import("@maplibre/maplibre-gl-leaflet");

                // The style changed (or the map unmounted) while we were
                // fetching the chunk — whatever we build now is stale.
                if (cancelled) return;

                layer = L.maplibreGL({
                    style: `${styleUrl(style)}${
                        apiKey ? `?key=${encodeURIComponent(apiKey)}` : ""
                    }`,
                    // The bridge builds the GL map with `attributionControl:
                    // false`, so CARTO's required attribution has to ride on
                    // the Leaflet layer instead.
                    attribution: CARTO_ATTRIBUTION,
                    // `pointer-events: none` on the canvas — every click still
                    // reaches Leaflet, so contextmenu, draw and pick mode are
                    // unaffected.
                    interactive: false,
                    // leaflet-easyprint screenshots the DOM via
                    // `canvas.toDataURL()`, which returns a transparent image
                    // for a WebGL canvas unless the drawing buffer is kept.
                    // Without this the basemap prints blank.
                    preserveDrawingBuffer: true,
                    transformRequest: cartoTransformRequest(apiKey),
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
    }, [map, style, apiKey]);

    return null;
};
