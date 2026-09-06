/// <reference lib="webworker" />
// Service worker for offline app-shell + runtime caching of third-party
// map/geocoding hosts.
//
// Build pipeline: `src/sw.ts` is bundled by esbuild + has its precache
// manifest injected by `@serwist/build` from a small Astro integration
// in `astro.config.mjs`. Output lands at `dist/client/sw.js`, served at
// `<base>sw.js`. See the integration's docblock for the full why.
//
// Caching strategy summary:
//   * App shell (HTML/JS/CSS/fonts/images shipped with the build) —
//     precached via `self.__SW_MANIFEST`. This is what makes the site
//     boot offline.
//   * Map tiles (Carto raster + vector, OSM, Thunderforest) —
//     StaleWhileRevalidate so previously-viewed tiles keep rendering
//     offline, with aggressive expiration caps so we don't blow out
//     storage. Vector basemaps additionally need their style JSON,
//     sprite and glyph ranges cached or they render blank/label-less
//     offline; glyphs are immutable so they go CacheFirst.
//   * Geocoders + boundary APIs (Photon, Nominatim) — SWR for offline
//     reuse. Overpass is network-only (see runtime route) so production
//     SW matches localhost behavior and avoids no-response failures.
//   * Same-origin API routes (/api/**) — NetworkFirst with a short
//     timeout so the live server's responses always win when online
//     but cached responses keep the UI alive when offline.
//
// Notes:
//   * `skipWaiting: false` is deliberate — clients dispatch SKIP_WAITING
//     from the update-available toast instead, so users keep control
//     over reloads while a game is in progress. See `src/lib/sw-register.ts`.

import {
    CacheableResponsePlugin,
    CacheFirst,
    ExpirationPlugin,
    NetworkFirst,
    NetworkOnly,
    type PrecacheEntry,
    Serwist,
    type SerwistGlobalConfig,
    StaleWhileRevalidate,
} from "serwist";

declare global {
    interface WorkerGlobalScope extends SerwistGlobalConfig {
        // Injected at build time by @serwist/vite. Holds the list of
        // precached URLs + revision hashes for the app shell.
        __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
    }
}

declare const self: ServiceWorkerGlobalScope;

const DAY = 24 * 60 * 60;

/**
 * Every runtime cache below wants the same two plugins: accept opaque (0) and
 * 200 responses, and evict by least-recently-used with a hard entry cap. Only
 * the cap and the TTL differ, so they are the only parameters here.
 */
const cachePlugins = (maxEntries: number, maxAgeSeconds: number) => [
    new CacheableResponsePlugin({ statuses: [0, 200] }),
    new ExpirationPlugin({
        maxEntries,
        maxAgeSeconds,
        maxAgeFrom: "last-used",
    }),
];

/** Serve from cache, refresh in the background. The default for tiles/APIs. */
const swr = (cacheName: string, maxEntries: number, maxAgeSeconds: number) =>
    new StaleWhileRevalidate({
        cacheName,
        plugins: cachePlugins(maxEntries, maxAgeSeconds),
    });

/** Serve from cache and never revalidate — for immutable, versioned URLs. */
const cacheFirst = (
    cacheName: string,
    maxEntries: number,
    maxAgeSeconds: number,
) =>
    new CacheFirst({
        cacheName,
        plugins: cachePlugins(maxEntries, maxAgeSeconds),
    });

const serwist = new Serwist({
    precacheEntries: self.__SW_MANIFEST,
    skipWaiting: false,
    clientsClaim: true,
    navigationPreload: true,
    runtimeCaching: [
        {
            // Carto basemaps (light_all / dark_all / voyager).
            matcher: /^https:\/\/[a-d]\.basemaps\.cartocdn\.com\/.*/i,
            handler: swr("tiles-cartocdn", 2000, 30 * DAY),
        },
        {
            // CARTO vector basemaps — style JSON, the source TileJSON and the
            // sprite sheet. These live on unsubdomained hosts the raster rule
            // above never matches, so without this rule a vector basemap is
            // entirely uncached and shows nothing offline. Requests carry
            // `?key=`, so a rotated key simply misses the cache and refetches.
            matcher: ({ url }: { url: URL }) =>
                url.hostname === "basemaps.cartocdn.com" ||
                (url.hostname === "tiles.basemaps.cartocdn.com" &&
                    (url.pathname.startsWith("/gl/") ||
                        url.pathname.startsWith("/vector/"))),
            handler: swr("carto-vector-style", 30, 30 * DAY),
        },
        {
            // Glyph ranges (PBF fonts) for vector labels. Immutable per
            // fontstack + codepoint range, and a session touches a few dozen,
            // so cache-first with a long TTL — a missing glyph range means
            // labels silently vanish from the map.
            matcher: ({ url }: { url: URL }) =>
                url.hostname === "tiles.basemaps.cartocdn.com" &&
                url.pathname.startsWith("/fonts/"),
            handler: cacheFirst("carto-vector-fonts", 300, 365 * DAY),
        },
        {
            // Vector tiles themselves (.mvt). CARTO's data maxzoom is 14 and
            // MapLibre overzooms past it, so a territory needs far fewer tiles
            // than the raster equivalent even though each one is larger.
            matcher:
                /^https:\/\/tiles-[a-d]\.basemaps\.cartocdn\.com\/vectortiles\/.*/i,
            handler: swr("tiles-carto-vector", 2000, 30 * DAY),
        },
        {
            // Standard OSM tile server.
            matcher: /^https:\/\/tile\.openstreetmap\.org\/.*/i,
            handler: swr("tiles-osm", 1500, 30 * DAY),
        },
        {
            // Thunderforest (Transport / Neighbourhood styles). API-keyed
            // but the key travels in the query string, so the URL is still
            // cacheable — different keys naturally get different cache
            // entries.
            matcher: /^https:\/\/tile\.thunderforest\.com\/.*/i,
            handler: swr("tiles-thunderforest", 1000, 30 * DAY),
        },
        {
            // Thunderforest vector basemaps. Everything — style document,
            // TileJSON, glyphs, sprites and .vector.pbf tiles — is served from
            // api.thunderforest.com (the raster rule above only matches
            // tile.thunderforest.com), with the key already baked into each
            // URL by the style document.
            matcher: ({ url }: { url: URL }) =>
                url.hostname === "api.thunderforest.com",
            handler: swr("thunderforest-vector", 2000, 30 * DAY),
        },
        {
            // OpenFreeMap — style, planet TileJSON, glyphs, sprites, Natural
            // Earth raster and the vector tiles themselves all live on
            // tiles.openfreemap.org, with no key anywhere.
            matcher: ({ url }: { url: URL }) =>
                url.hostname === "tiles.openfreemap.org",
            handler: swr("tiles-openfreemap", 2000, 30 * DAY),
        },
        {
            // Photon geocoder — direct in dev, proxied in prod via /api/proxy-api.
            matcher: ({ url }: { url: URL }) =>
                url.hostname === "photon.komoot.io" ||
                (url.pathname === "/api/proxy-api" &&
                    (url.searchParams.get("url") ?? "").includes(
                        "photon.komoot.io",
                    )),
            handler: swr("geocoder-photon", 200, 7 * DAY),
        },
        {
            // Nominatim — boundary polygons + reverse geocoding. Cache
            // aggressively because boundaries are the expensive thing we
            // want to survive a reload. Matches both direct and proxied URLs.
            matcher: ({ url }: { url: URL }) =>
                url.hostname === "nominatim.openstreetmap.org" ||
                (url.pathname === "/api/proxy-api" &&
                    (url.searchParams.get("url") ?? "").includes(
                        "nominatim.openstreetmap.org",
                    )),
            handler: swr("boundaries-nominatim", 200, 30 * DAY),
        },
        {
            // Overpass — network-only (see comment below). Matches both
            // direct domain (dev) and /api/proxy-api (prod).
            matcher: ({ url }: { url: URL }) =>
                /^(overpass-api\.de|overpass\.kumi\.systems|overpass\.private\.coffee)$/.test(
                    url.hostname,
                ) ||
                (url.pathname === "/api/proxy-api" &&
                    /overpass/.test(url.searchParams.get("url") ?? "")),
            method: "GET" as const,
            handler: new NetworkOnly(),
        },
        {
            // Leaflet marker sprites, Leaflet-Draw assets, and similar
            // third-party assets loaded from unpkg / jsdelivr. CacheFirst
            // because these are versioned URLs — they either change path
            // on upgrade or don't change at all.
            matcher: /^https:\/\/(unpkg\.com|cdn\.jsdelivr\.net)\/.*/i,
            handler: cacheFirst("vendor-assets", 40, 365 * DAY),
        },
        {
            // MapLibre's chunks are deliberately excluded from the precache
            // manifest (see astro.config.mjs) so players on raster basemaps
            // never download them. Cache them at runtime instead, so someone
            // who does pick a vector basemap keeps it offline afterwards.
            matcher: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) =>
                sameOrigin &&
                /maplibre-gl\.[^/]+\.(js|css)$/i.test(url.pathname),
            handler: cacheFirst("maplibre-assets", 10, 365 * DAY),
        },
        {
            // Same-origin API routes (on Railway these are live node
            // endpoints; on GH Pages they 404 and the client falls back
            // to the public CORS proxy). NetworkFirst with a short
            // timeout means we try the server first but don't hang if
            // the user is offline.
            matcher: ({ url, sameOrigin }) =>
                sameOrigin && url.pathname.startsWith("/api/"),
            handler: new NetworkFirst({
                cacheName: "api",
                networkTimeoutSeconds: 10,
                plugins: cachePlugins(50, DAY),
            }),
        },
    ],
});

serwist.addEventListeners();
