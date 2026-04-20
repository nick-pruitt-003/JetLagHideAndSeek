import * as turf from "@turf/turf";
import type { FeatureCollection, MultiPolygon } from "geojson";

/** GET URLs longer than this often fail (browser/proxy limits); use POST instead. */
const MAX_OVERPASS_GET_URL_LENGTH = 7500;
/** One Overpass query with many `map_to_area` blocks is slow and RAM-heavy; split beyond this. */
const MULTI_AREA_SPLIT_THRESHOLD = 4;
/** Avoid too many concurrent Overpass requests per batch. */
const MULTI_AREA_PARALLEL_CHUNK = 4;
/** Keep `poly:"…"` clauses small enough for GET and faster server-side evaluation. */
const MAX_POLY_INLINE_LENGTH = 5200;
import _ from "lodash";
import { toast } from "react-toastify";

import {
    additionalMapGeoLocations,
    mapGeoLocation,
    polyGeoJSON,
} from "@/lib/context";
import { cacheFetch, determineCache } from "@/maps/api/cache";
import {
    LOCATION_FIRST_TAG,
    NOMINATIM_API,
    OVERPASS_API,
    OVERPASS_API_FALLBACK,
} from "@/maps/api/constants";
import osmtogeojson from "@/maps/api/osm-to-geojson";
import type {
    EncompassingTentacleQuestionSchema,
    HomeGameMatchingQuestions,
    HomeGameMeasuringQuestions,
    QuestionSpecificLocation,
} from "@/maps/api/types";
import { CacheType } from "@/maps/api/types";
import { safeUnion } from "@/maps/geo-utils";

function dedupeOsmElements(elements: any[]): any[] {
    const seen = new Set<string>();
    const out: any[] = [];
    for (const el of elements) {
        if (!el || typeof el.type !== "string" || typeof el.id !== "number")
            continue;
        const k = `${el.type}\0${el.id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(el);
    }
    return out;
}

/**
 * Build the lat/lon space-separated string for Overpass `poly:"…"` from a
 * feature collection, simplifying until the clause fits GET limits and
 * evaluates in reasonable time on the server.
 */
export function polyClauseStringForOverpass(
    fc: FeatureCollection,
): string {
    const build = (c: FeatureCollection) =>
        turf
            .getCoords(c.features as any)
            .flatMap((polygon: any) => polygon.geometry.coordinates)
            .flat()
            .map((coord: number[]) => `${coord[1]} ${coord[0]}`)
            .join(" ");

    let tolerance = 0.00006;
    let current = fc;
    let str = build(current);
    let guard = 0;
    while (str.length > MAX_POLY_INLINE_LENGTH && guard++ < 28) {
        tolerance *= 1.35;
        current = turf.simplify(fc, {
            tolerance,
            highQuality: true,
        }) as FeatureCollection;
        str = build(current);
    }
    return str;
}

const getOverpassData = async (
    query: string,
    loadingText?: string,
    cacheType: CacheType = CacheType.CACHE,
) => {
    const encodedQuery = encodeURIComponent(query);
    const primaryUrl = `${OVERPASS_API}?data=${encodedQuery}`;
    const usePost = primaryUrl.length > MAX_OVERPASS_GET_URL_LENGTH;

    const fetchOverpassPost = async (): Promise<Response> => {
        let response = await fetch(OVERPASS_API, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: `data=${encodedQuery}`,
        });
        if (!response.ok) {
            response = await fetch(OVERPASS_API_FALLBACK, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: `data=${encodedQuery}`,
            });
        }
        if (response.ok) {
            const cache = await determineCache(cacheType);
            await cache.put(primaryUrl, response.clone());
        }
        return response;
    };

    let response: Response;

    if (usePost) {
        const cache = await determineCache(cacheType);
        const cachedResponse = await cache.match(primaryUrl);
        if (cachedResponse?.ok) {
            response = cachedResponse.clone();
        } else {
            const pending = fetchOverpassPost();
            response = loadingText
                ? await toast.promise(pending, { pending: loadingText })
                : await pending;
        }
    } else {
        response = await cacheFetch(primaryUrl, loadingText, cacheType);
    }

    if (!response.ok && !usePost) {
        // Try the fallback, but store the result under the primary URL key so future requests are served from cache without needing to fail-over again.
        try {
            const fallbackResponse = await cacheFetch(
                `${OVERPASS_API_FALLBACK}?data=${encodedQuery}`,
                loadingText,
                cacheType,
            );
            if (fallbackResponse.ok) {
                const cache = await determineCache(cacheType);
                await cache.put(primaryUrl, fallbackResponse.clone());
            }
            response = fallbackResponse;
        } catch {
            toast.error(
                `Could not load data from Overpass: ${response.status} ${response.statusText}`,
                { toastId: "overpass-error" },
            );
            return { elements: [] };
        }
    }

    if (!response.ok) {
        toast.error(
            `Could not load data from Overpass: ${response.status} ${response.statusText}`,
            { toastId: "overpass-error" },
        );
        return { elements: [] };
    }

    const data = await response.json();
    return data;
};

const OSM_TYPE_LONG: Record<"W" | "R" | "N", string> = {
    W: "way",
    R: "relation",
    N: "node",
};

/**
 * Turn Nominatim `/lookup?polygon_geojson=1&format=json` response into
 * the FeatureCollection shape the rest of the app expects.
 *
 * Exported for unit testing. Returns `null` when the payload contains
 * no usable polygon so callers can fall back to Overpass.
 */
export const parseNominatimBoundaryPayload = (
    raw: unknown,
): { type: "FeatureCollection"; features: any[] } | null => {
    if (!Array.isArray(raw) || raw.length === 0) return null;

    const features = raw
        .map((entry) => {
            if (!entry || typeof entry !== "object") return null;
            const r = entry as Record<string, unknown>;
            const geom = r.geojson as
                | { type: string; coordinates: unknown }
                | undefined;
            if (!geom || typeof geom !== "object") return null;
            if (geom.type !== "Polygon" && geom.type !== "MultiPolygon") {
                return null;
            }
            return {
                type: "Feature" as const,
                properties: {
                    osm_id: r.osm_id,
                    osm_type: r.osm_type,
                    source: "nominatim",
                },
                geometry: geom,
            };
        })
        .filter((f): f is NonNullable<typeof f> => f !== null);

    if (features.length === 0) return null;
    return { type: "FeatureCollection", features };
};

/**
 * Fetch a region boundary polygon from Nominatim's `/lookup` endpoint.
 *
 * Nominatim pre-simplifies boundary polygons: Japan is ~190KB here
 * versus 4-10MB from Overpass `out geom`, and it responds in under a
 * second even when Overpass is hammered (we repeatedly see 504s for
 * country-level relations on cold Railway loads).
 *
 * Returns `null` when Nominatim refuses, responds malformed, or has no
 * polygon for the id; callers should treat `null` as "fall back to
 * Overpass".
 */
const fetchNominatimBoundary = async (
    osmId: string,
    osmTypeLetter: "W" | "R" | "N",
    loadingText?: string,
): Promise<any | null> => {
    // Nominatim expects a prefix-letter-plus-id list: R382313, W123, N456.
    const osmIds = `${osmTypeLetter}${osmId}`;
    const url =
        `${NOMINATIM_API}/lookup` +
        `?osm_ids=${encodeURIComponent(osmIds)}` +
        `&polygon_geojson=1` +
        `&format=json`;

    let response: Response;
    try {
        response = await cacheFetch(
            url,
            loadingText,
            CacheType.PERMANENT_CACHE,
        );
    } catch {
        return null;
    }
    if (!response.ok) return null;

    let raw: unknown;
    try {
        raw = await response.json();
    } catch {
        return null;
    }
    return parseNominatimBoundaryPayload(raw);
};

export interface DetermineGeoJSONOptions {
    /**
     * Skip Nominatim and go straight to Overpass's `out geom` query.
     * Used by the "Load detailed boundary" upgrade flow when the user
     * explicitly wants coastline-precision geometry and is willing to
     * wait for the larger payload.
     */
    forceDetailed?: boolean;
}

const determineGeoJSON = async (
    osmId: string,
    osmTypeLetter: "W" | "R" | "N",
    opts: DetermineGeoJSONOptions = {},
): Promise<any> => {
    // Nominatim first: its pre-simplified polygons are one to two orders
    // of magnitude smaller than Overpass `out geom` and survive periods
    // when Overpass is timing out. We only fall back to Overpass when
    // Nominatim returns nothing usable, or when the caller has
    // explicitly requested detailed geometry.
    if (!opts.forceDetailed) {
        const nominatimResult = await fetchNominatimBoundary(
            osmId,
            osmTypeLetter,
            "Loading map data...",
        );
        if (nominatimResult) {
            return nominatimResult;
        }
    }

    const osmType = OSM_TYPE_LONG[osmTypeLetter];
    const query = `[out:json];${osmType}(${osmId});out geom;`;
    const data = await getOverpassData(
        query,
        opts.forceDetailed
            ? "Loading detailed boundary..."
            : "Loading map data (fallback)...",
        CacheType.PERMANENT_CACHE,
    );
    const geo = osmtogeojson(data);
    return {
        ...geo,
        features: geo.features.filter(
            (feature: any) => feature.geometry.type !== "Point",
        ),
    };
};

export const findTentacleLocations = async (
    question: EncompassingTentacleQuestionSchema,
    text: string = "Determining tentacle locations...",
) => {
    const query = `
[out:json][timeout:25];
nwr["${LOCATION_FIRST_TAG[question.locationType]}"="${question.locationType}"](around:${turf.convertLength(
        question.radius,
        question.unit,
        "meters",
    )}, ${question.lat}, ${question.lng});
out center;
    `;
    const data = await getOverpassData(query, text);
    const elements = data.elements;
    const response = turf.points([]);
    elements.forEach((element: any) => {
        if (!element.tags["name"] && !element.tags["name:en"]) return;
        if (element.lat && element.lon) {
            const name = element.tags["name:en"] ?? element.tags["name"];
            if (
                response.features.find(
                    (feature: any) => feature.properties.name === name,
                )
            )
                return;
            response.features.push(
                turf.point([element.lon, element.lat], { name }),
            );
        }
        if (!element.center || !element.center.lon || !element.center.lat)
            return;
        const name = element.tags["name:en"] ?? element.tags["name"];
        if (
            response.features.find(
                (feature: any) => feature.properties.name === name,
            )
        )
            return;
        response.features.push(
            turf.point([element.center.lon, element.center.lat], { name }),
        );
    });
    return response;
};

export const findAdminBoundary = async (
    latitude: number,
    longitude: number,
    adminLevel: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10,
) => {
    const query = `
[out:json];
is_in(${latitude}, ${longitude})->.a;
rel(pivot.a)["admin_level"="${adminLevel}"];
out geom;
    `;
    const data = await getOverpassData(query, "Determining matching zone...");
    const geo = osmtogeojson(data);
    return geo.features?.[0];
};

export const fetchCoastline = async () => {
    const response = await cacheFetch(
        import.meta.env.BASE_URL + "/coastline50.geojson",
        "Fetching coastline data...",
        CacheType.PERMANENT_CACHE,
    );
    const data = await response.json();
    return data;
};

export const trainLineNodeFinder = async (node: string): Promise<number[]> => {
    const nodeId = node.split("/")[1];
    const tagQuery = `
[out:json];
node(${nodeId});
wr(bn);
out tags;
`;
    const tagData = await getOverpassData(tagQuery, "Finding train line...");
    const query = `
[out:json];
(
${tagData.elements
    .map((element: any) => {
        if (
            !element.tags.name &&
            !element.tags["name:en"] &&
            !element.tags.network
        )
            return "";
        let query = "";
        if (element.tags.name) query += `wr["name"="${element.tags.name}"];`;
        if (element.tags["name:en"])
            query += `wr["name:en"="${element.tags["name:en"]}"];`;
        if (element.tags["network"])
            query += `wr["network"="${element.tags["network"]}"];`;
        return query;
    })
    .join("\n")}
);
out geom;
`;
    const data = await getOverpassData(query, "Finding train lines...");
    const geoJSON = osmtogeojson(data);
    const nodes: number[] = [];
    geoJSON.features.forEach((feature: any) => {
        if (feature && feature.id && feature.id.startsWith("node")) {
            nodes.push(parseInt(feature.id.split("/")[1]));
        }
    });
    data.elements.forEach((element: any) => {
        if (element && element.type === "node") {
            nodes.push(element.id);
        } else if (element && element.type === "way") {
            nodes.push(...element.nodes);
        }
    });
    const uniqNodes = _.uniq(nodes);
    return uniqNodes;
};

export const findPlacesInZone = async (
    filter: string,
    loadingText?: string,
    searchType:
        | "node"
        | "way"
        | "relation"
        | "nwr"
        | "nw"
        | "wr"
        | "nr"
        | "area" = "nwr",
    outType: "center" | "geom" = "center",
    alternatives: string[] = [],
    timeoutDuration: number = 0,
) => {
    const $polyGeoJSON = polyGeoJSON.get();
    const jsonHeader =
        timeoutDuration !== 0
            ? `[out:json][timeout:${timeoutDuration}][maxsize:536870912]`
            : `[out:json]`;

    let data: { elements?: any[] };

    if ($polyGeoJSON) {
        const polyStr = polyClauseStringForOverpass($polyGeoJSON);
        const query = `
${jsonHeader};
(
${searchType}${filter}(poly:"${polyStr}");
${
    alternatives.length > 0
        ? alternatives
              .map(
                  (alternative) =>
                      `${searchType}${alternative}(poly:"${polyStr}");`,
              )
              .join("\n")
        : ""
}
);
out ${outType};
`;
        data = await getOverpassData(
            query,
            loadingText,
            CacheType.ZONE_CACHE,
        );
    } else {
        const primaryLocation = mapGeoLocation.get();
        const additionalLocations = additionalMapGeoLocations
            .get()
            .filter((entry) => entry.added)
            .map((entry) => entry.location);
        const allLocations = [primaryLocation, ...additionalLocations];

        if (allLocations.length >= MULTI_AREA_SPLIT_THRESHOLD) {
            const header =
                timeoutDuration !== 0
                    ? `[out:json][timeout:${timeoutDuration}][maxsize:536870912];`
                    : `[out:json][maxsize:536870912];`;

            const runSplit = async () => {
                const queries = allLocations.map((loc) => {
                    const relationToAreaBlocks = `relation(${loc.properties.osm_id});map_to_area->.region0;`;
                    const regionVar = `area.region0`;
                    const altQueries =
                        alternatives.length > 0
                            ? alternatives
                                  .map(
                                      (alt) =>
                                          `${searchType}${alt}(${regionVar});`,
                                  )
                                  .join("\n")
                            : "";
                    return `
${header}
${relationToAreaBlocks}
(
            ${searchType}${filter}(${regionVar});
            ${altQueries}
);
out ${outType};
`;
                });

                const merged: any[] = [];
                for (
                    let i = 0;
                    i < queries.length;
                    i += MULTI_AREA_PARALLEL_CHUNK
                ) {
                    const chunk = queries.slice(i, i + MULTI_AREA_PARALLEL_CHUNK);
                    const parts = await Promise.all(
                        chunk.map((q) =>
                            getOverpassData(q, undefined, CacheType.ZONE_CACHE),
                        ),
                    );
                    for (const p of parts) {
                        merged.push(...(p.elements ?? []));
                    }
                }
                return { elements: dedupeOsmElements(merged) };
            };

            data = loadingText
                ? await toast.promise(runSplit(), { pending: loadingText })
                : await runSplit();
        } else {
            const relationToAreaBlocks = allLocations
                .map((loc, idx) => {
                    const regionVar = `.region${idx}`;
                    return `relation(${loc.properties.osm_id});map_to_area->${regionVar};`;
                })
                .join("\n");
            const searchBlocks = allLocations
                .map((_, idx) => {
                    const regionVar = `area.region${idx}`;
                    const altQueries =
                        alternatives.length > 0
                            ? alternatives
                                  .map(
                                      (alt) =>
                                          `${searchType}${alt}(${regionVar});`,
                                  )
                                  .join("\n")
                            : "";
                    return `
            ${searchType}${filter}(${regionVar});
            ${altQueries}
          `;
                })
                .join("\n");
            const query = `
        ${jsonHeader};
        ${relationToAreaBlocks}
        (
        ${searchBlocks}
        );
        out ${outType};
        `;
            data = await getOverpassData(
                query,
                loadingText,
                CacheType.ZONE_CACHE,
            );
        }
    }
    if (!data.elements) {
        data.elements = [];
    }

    const subtractedEntries = additionalMapGeoLocations
        .get()
        .filter((e) => !e.added);
    const subtractedPolygons = subtractedEntries.map((entry) => entry.location);
    if (subtractedPolygons.length > 0 && data.elements.length > 0) {
        const turfPolys = await Promise.all(
            subtractedPolygons.map(
                async (location) =>
                    turf.combine(
                        await determineGeoJSON(
                            location.properties.osm_id.toString(),
                            location.properties.osm_type,
                        ),
                    ).features[0],
            ),
        );
        data.elements = data.elements.filter((el: any) => {
            const lon = el.center ? el.center.lon : el.lon;
            const lat = el.center ? el.center.lat : el.lat;
            if (typeof lon !== "number" || typeof lat !== "number")
                return false;
            const pt = turf.point([lon, lat]);
            return !turfPolys.some((poly) =>
                turf.booleanPointInPolygon(pt, poly as any),
            );
        });
    }
    return data as { elements: any[]; remark?: string };
};

/**
 * Return the set of OSM node IDs that are members of heritage /
 * tourist / preserved / abandoned railway ways within the current
 * scope.
 *
 * We use this to post-filter station lists when the user opts to
 * exclude heritage railways — stations themselves almost never carry
 * the relevant tags (they usually look like a normal
 * `railway=station`), but the way they sit on does. Node-level
 * filtering in the Overpass query isn't sufficient for this.
 *
 * Cached under ZONE_CACHE so toggling the option (or editing questions)
 * doesn't re-hit the network.
 */
function heritageNodeIdsFromElements(elements: any[] | undefined): Set<number> {
    const ids = new Set<number>();
    for (const el of elements ?? []) {
        if (el.type === "node" && typeof el.id === "number") {
            ids.add(el.id);
        }
    }
    return ids;
}

export const findHeritageRailwayMemberNodeIds = async (): Promise<
    Set<number>
> => {
    const $polyGeoJSON = polyGeoJSON.get();

    // The candidate "non-active heritage" railway way tags. We pick up
    // member nodes of any way matching one of these; those nodes are
    // then dropped from the station list.
    const wayFilters = [
        '["railway:preserved"="yes"]',
        '["railway"]["usage"="tourism"]',
        '["railway"="abandoned"]',
        '["railway"="disused"]',
        '["railway"="heritage"]',
    ];

    const heritageQuery = (scopeBlock: string) => `
[out:json][timeout:120][maxsize:536870912];
(
${scopeBlock}
)->.heritage_ways;
node(w.heritage_ways);
out ids;
`;

    if ($polyGeoJSON) {
        const poly = polyClauseStringForOverpass($polyGeoJSON);
        const scopeBlock = wayFilters
            .map((f) => `way${f}(poly:"${poly}");`)
            .join("\n");
        const data = await getOverpassData(
            heritageQuery(scopeBlock),
            "Finding heritage railway lines...",
            CacheType.ZONE_CACHE,
        );
        return heritageNodeIdsFromElements(data.elements);
    }

    const primaryLocation = mapGeoLocation.get();
    const additionalLocations = additionalMapGeoLocations
        .get()
        .filter((entry) => entry.added)
        .map((entry) => entry.location);
    const allLocations = [primaryLocation, ...additionalLocations];

    if (allLocations.length >= MULTI_AREA_SPLIT_THRESHOLD) {
        const runSplit = async () => {
            const ids = new Set<number>();
            const queries = allLocations.map((loc) => {
                const scope = wayFilters
                    .map((f) => `way${f}(area.r0);`)
                    .join("\n");
                return `
[out:json][timeout:120][maxsize:536870912];
relation(${loc.properties.osm_id});map_to_area->.r0;
(
${scope}
)->.heritage_ways;
node(w.heritage_ways);
out ids;
`;
            });

            for (let i = 0; i < queries.length; i += MULTI_AREA_PARALLEL_CHUNK) {
                const chunk = queries.slice(i, i + MULTI_AREA_PARALLEL_CHUNK);
                const parts = await Promise.all(
                    chunk.map((q) =>
                        getOverpassData(q, undefined, CacheType.ZONE_CACHE),
                    ),
                );
                for (const p of parts) {
                    for (const id of heritageNodeIdsFromElements(p.elements)) {
                        ids.add(id);
                    }
                }
            }
            return ids;
        };

        return toast.promise(runSplit(), {
            pending: "Finding heritage railway lines...",
        });
    }

    const areaBlocks = allLocations
        .map(
            (loc, idx) =>
                `relation(${loc.properties.osm_id});map_to_area->.region${idx};`,
        )
        .join("\n");
    const searchBlocks = allLocations
        .flatMap((_loc, idx) =>
            wayFilters.map((f) => `way${f}(area.region${idx});`),
        )
        .join("\n");
    const scopeBlock = `${areaBlocks}\n${searchBlocks}`;

    const data = await getOverpassData(
        heritageQuery(scopeBlock),
        "Finding heritage railway lines...",
        CacheType.ZONE_CACHE,
    );

    return heritageNodeIdsFromElements(data.elements);
};

export const findPlacesSpecificInZone = async (
    location: `${QuestionSpecificLocation}`,
) => {
    const locations = (
        await findPlacesInZone(
            location,
            `Finding ${
                location === '["brand:wikidata"="Q38076"]'
                    ? "McDonald's"
                    : "7-Elevens"
            }...`,
        )
    ).elements;
    return turf.featureCollection(
        locations.map((x: any) =>
            turf.point([
                x.center ? x.center.lon : x.lon,
                x.center ? x.center.lat : x.lat,
            ]),
        ),
    );
};

export const nearestToQuestion = async (
    question: HomeGameMatchingQuestions | HomeGameMeasuringQuestions,
) => {
    let radius = 30;
    let instances: any = { features: [] };
    while (instances.features.length === 0) {
        instances = await findTentacleLocations(
            {
                lat: question.lat,
                lng: question.lng,
                radius: radius,
                unit: "miles",
                location: false,
                locationType: question.type,
                drag: false,
                color: "black",
                collapsed: false,
            },
            "Finding matching locations...",
        );
        radius += 30;
    }
    const questionPoint = turf.point([question.lng, question.lat]);
    return turf.nearestPoint(questionPoint, instances as any);
};

export const determineMapBoundaries = async (
    opts: DetermineGeoJSONOptions = {},
) => {
    const mapGeoDatum = await Promise.all(
        [
            {
                location: mapGeoLocation.get(),
                added: true,
                base: true,
            },
            ...additionalMapGeoLocations.get(),
        ].map(async (location) => ({
            added: location.added,
            data: await determineGeoJSON(
                location.location.properties.osm_id.toString(),
                location.location.properties.osm_type,
                opts,
            ),
        })),
    );

    let mapGeoData = turf.featureCollection([
        safeUnion(
            turf.featureCollection(
                mapGeoDatum
                    .filter((x) => x.added)
                    .flatMap((x) => x.data.features),
            ) as any,
        ),
    ]);

    const differences = mapGeoDatum.filter((x) => !x.added).map((x) => x.data);

    if (differences.length > 0) {
        mapGeoData = turf.featureCollection([
            turf.difference(
                turf.featureCollection([
                    mapGeoData.features[0],
                    ...differences.flatMap((x) => x.features),
                ]),
            )!,
        ]);
    }

    if (turf.coordAll(mapGeoData).length > 10000) {
        turf.simplify(mapGeoData, {
            tolerance: 0.0005,
            highQuality: true,
            mutate: true,
        });
    }

    return turf.combine(mapGeoData) as FeatureCollection<MultiPolygon>;
};
