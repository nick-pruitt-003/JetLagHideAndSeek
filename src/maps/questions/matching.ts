import * as turf from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    MultiPolygon,
    Point,
    Polygon,
} from "geojson";
import _ from "lodash";
import { toast } from "react-toastify";

import {
    hiderMode,
    mapGeoJSON,
    mapGeoLocation,
    playableTerritoryUnion,
    polyGeoJSON,
} from "@/lib/context";
import {
    findAdminBoundary,
    findPlacesInZone,
    nearestToQuestion,
    OVERPASS_MAJOR_CITY_FILTER,
    overpassAirportIataFilter,
    prettifyLocation,
    trainLineNodeFinder,
} from "@/maps/api";
import osmtogeojson from "@/maps/api/osm-to-geojson";
import { holedMask, modifyMapData, safeUnion } from "@/maps/geo-utils";
import { geoSpatialVoronoi } from "@/maps/geo-utils";
import {
    fetchFullFacilityElements,
    filterFacilityPointsByDisabledOsmRefs,
    osmElementsToFacilityPoints,
    validateFullFacilityFetch,
} from "@/maps/questions/facility-full";
import type {
    APILocations,
    HomeGameMatchingQuestions,
    MatchingQuestion,
    MatchingQuestionWithFacilityOsmRefs,
} from "@/maps/schema";

export function normalizeMatchingAirportIata(s: string): string {
    return s.trim().toUpperCase();
}

async function fetchAirportPointsUnfiltered(
    question: MatchingQuestion,
): Promise<Feature<Point>[]> {
    if (question.type !== "airport") return [];
    const elements = _.uniqBy(
        (
            await findPlacesInZone(
                overpassAirportIataFilter({
                    activeOnly: question.activeOnly === true,
                }),
                "Finding airports...",
                "nwr",
                "center",
                [],
                240,
            )
        ).elements,
        (feature: any) => feature.tags?.iata,
    );
    return elements.map((x: any) => {
        const lng = x.center ? x.center.lon : x.lon;
        const lat = x.center ? x.center.lat : x.lat;
        const iata = normalizeMatchingAirportIata(String(x.tags?.iata ?? ""));
        const name =
            typeof x.tags?.name === "string" && x.tags.name.trim()
                ? x.tags.name.trim()
                : iata || "Airport";
        return turf.point([lng, lat], { iata, name });
    });
}

function filterAirportsByDisabled(
    points: Feature<Point>[],
    question: MatchingQuestion,
): Feature<Point>[] {
    if (question.type !== "airport") return points;
    const disabled = new Set(
        (question.disabledAirportIatas ?? []).map(normalizeMatchingAirportIata),
    );
    return points.filter((p) => {
        const iata = normalizeMatchingAirportIata(
            String((p.properties as { iata?: string } | null)?.iata ?? ""),
        );
        return iata.length > 0 && !disabled.has(iata);
    });
}

/** All IATA airports in the current territory (before per-airport exclusions). */
export async function listAirportMatchingCandidates(
    question: MatchingQuestion,
): Promise<Feature<Point>[]> {
    return fetchAirportPointsUnfiltered(question);
}

export const findMatchingPlaces = async (question: MatchingQuestion) => {
    switch (question.type) {
        case "airport": {
            return filterAirportsByDisabled(
                await fetchAirportPointsUnfiltered(question),
                question,
            );
        }
        case "major-city": {
            const cityData = await findPlacesInZone(
                OVERPASS_MAJOR_CITY_FILTER,
                "Finding cities...",
            );
            const pts = osmElementsToFacilityPoints(cityData.elements ?? []);
            return filterFacilityPointsByDisabledOsmRefs(
                pts,
                (question as MatchingQuestionWithFacilityOsmRefs)
                    .disabledFacilityOsmRefs,
            );
        }
        case "custom-points": {
            return question.geo!;
        }
        case "aquarium-full":
        case "zoo-full":
        case "theme_park-full":
        case "peak-full":
        case "museum-full":
        case "hospital-full":
        case "cinema-full":
        case "library-full":
        case "golf_course-full":
        case "consulate-full":
        case "park-full": {
            const location = question.type.split("-full")[0] as APILocations;

            const { elements, remark } = await fetchFullFacilityElements(
                location,
                `Finding ${prettifyLocation(location, true).toLowerCase()}...`,
            );
            if (!validateFullFacilityFetch(elements, remark, location)) {
                return [];
            }
            const pts = osmElementsToFacilityPoints(elements);
            return filterFacilityPointsByDisabledOsmRefs(
                pts,
                (question as MatchingQuestionWithFacilityOsmRefs)
                    .disabledFacilityOsmRefs,
            );
        }
    }
};

export const determineMatchingBoundary = _.memoize(
    async (question: MatchingQuestion) => {
        let boundary;

        switch (question.type) {
            case "aquarium":
            case "zoo":
            case "theme_park":
            case "peak":
            case "museum":
            case "hospital":
            case "cinema":
            case "library":
            case "golf_course":
            case "consulate":
            case "park":
            case "same-first-letter-station":
            case "same-length-station":
            case "same-train-line": {
                return false;
            }
            case "custom-zone": {
                boundary = question.geo;
                break;
            }
            case "zone":
            case "same-admin-zone": {
                boundary = await findAdminBoundary(
                    question.lat,
                    question.lng,
                    question.cat.adminLevel,
                );

                if (!boundary) {
                    toast.error("No boundary found for this zone");
                    throw new Error("No boundary found");
                }
                break;
            }
            case "letter-zone": {
                const zone = await findAdminBoundary(
                    question.lat,
                    question.lng,
                    question.cat.adminLevel,
                );

                if (!zone) {
                    toast.error("No boundary found for this zone");
                    throw new Error("No boundary found");
                }

                let englishName = zone.properties?.["name:en"];

                if (!englishName) {
                    const name = zone.properties?.name;

                    if (/^[a-zA-Z]$/.test(name[0])) {
                        englishName = name;
                    } else {
                        toast.error("No English name found for this zone");
                        throw new Error("No English name");
                    }
                }

                const letter = englishName[0].toUpperCase();

                boundary = turf.featureCollection(
                    osmtogeojson(
                        await findPlacesInZone(
                            `[admin_level=${question.cat.adminLevel}]["name:en"~"^${letter}.+"]`, // Regex is faster than filtering afterward
                            `Finding zones that start with the same letter (${letter})...`,
                            "relation",
                            "geom",
                            [
                                `[admin_level=${question.cat.adminLevel}]["name"~"^${letter}.+"]`,
                            ], // Regex is faster than filtering afterward
                        ),
                    ).features.filter(
                        (x): x is Feature<Polygon | MultiPolygon> =>
                            x.geometry &&
                            (x.geometry.type === "Polygon" ||
                                x.geometry.type === "MultiPolygon"),
                    ),
                );

                // It's either simplify or crash. Technically this could be bad if someone's hiding zone was inside multiple zones, but that's unlikely.
                boundary = safeUnion(
                    turf.simplify(boundary, {
                        tolerance: 0.001,
                        highQuality: true,
                        mutate: true,
                    }),
                );

                break;
            }
            case "airport":
            case "major-city":
            case "aquarium-full":
            case "zoo-full":
            case "theme_park-full":
            case "peak-full":
            case "museum-full":
            case "hospital-full":
            case "cinema-full":
            case "library-full":
            case "golf_course-full":
            case "consulate-full":
            case "park-full":
            case "custom-points": {
                const data = await findMatchingPlaces(question);
                const fc: FeatureCollection<Point> = Array.isArray(data)
                    ? turf.featureCollection(data)
                    : (data as FeatureCollection<Point>);
                if (!fc.features.length) {
                    break;
                }

                const voronoi = geoSpatialVoronoi(fc);
                const point = turf.point([question.lng, question.lat]);

                for (const feature of voronoi.features) {
                    if (turf.booleanPointInPolygon(point, feature)) {
                        boundary = feature;
                        break;
                    }
                }
                break;
            }
        }

        return boundary;
    },
    (question: MatchingQuestion & { geo?: unknown; cat?: unknown }) => {
        const airportExtras =
            question.type === "airport"
                ? {
                      activeOnly: question.activeOnly === true,
                      disabledAirportIatas: [
                          ...(question.disabledAirportIatas ?? []),
                      ]
                          .map(normalizeMatchingAirportIata)
                          .filter(Boolean)
                          .sort(),
                  }
                : {};
        const qRefs = (question as MatchingQuestionWithFacilityOsmRefs)
            .disabledFacilityOsmRefs;
        const facilityOsmExtras =
            question.type === "major-city" ||
            (typeof question.type === "string" &&
                question.type.endsWith("-full"))
                ? {
                      disabledFacilityOsmRefs: [...(qRefs ?? [])]
                          .map((s) => s.trim().toLowerCase())
                          .filter(Boolean)
                          .sort(),
                  }
                : {};
        const ptu = playableTerritoryUnion.get();
        const playableDigest =
            ptu?.geometry != null
                ? turf
                      .bbox(ptu as Feature<Polygon | MultiPolygon>)
                      .map((x: number) => x.toFixed(4))
                      .join(",")
                : undefined;
        return JSON.stringify({
            type: question.type,
            lat: question.lat,
            lng: question.lng,
            cat: question.cat,
            geo: question.geo,
            entirety: polyGeoJSON.get()
                ? polyGeoJSON.get()
                : mapGeoLocation.get(),
            playableDigest,
            ...airportExtras,
            ...facilityOsmExtras,
        });
    },
);

export const adjustPerMatching = async (
    question: MatchingQuestion,
    mapData: any,
) => {
    if (mapData === null) return;

    const boundary = await determineMatchingBoundary(question);

    if (boundary === false) {
        return mapData;
    }

    return modifyMapData(mapData, boundary, question.same);
};

export const hiderifyMatching = async (question: MatchingQuestion) => {
    const $hiderMode = hiderMode.get();
    if ($hiderMode === false) {
        return question;
    }

    if (
        [
            "aquarium",
            "zoo",
            "theme_park",
            "peak",
            "museum",
            "hospital",
            "cinema",
            "library",
            "golf_course",
            "consulate",
            "park",
        ].includes(question.type)
    ) {
        const questionNearest = await nearestToQuestion(
            question as HomeGameMatchingQuestions,
        );
        const hiderNearest = await nearestToQuestion({
            lat: $hiderMode.latitude,
            lng: $hiderMode.longitude,
            same: true,
            type: (question as HomeGameMatchingQuestions).type,
            drag: false,
            color: "black",
            collapsed: false,
        });

        question.same =
            questionNearest.properties.name === hiderNearest.properties.name;

        return question;
    }

    if (
        question.type === "same-first-letter-station" ||
        question.type === "same-length-station" ||
        question.type === "same-train-line"
    ) {
        const hiderPoint = turf.point([
            $hiderMode.longitude,
            $hiderMode.latitude,
        ]);
        const seekerPoint = turf.point([question.lng, question.lat]);

        const places = osmtogeojson(
            await findPlacesInZone(
                "[railway=station]",
                "Finding train stations. This may take a while. Do not press any buttons while this is processing. Don't worry, it will be cached.",
                "node",
            ),
        ) as FeatureCollection<Point>;

        const nearestHiderTrainStation = turf.nearestPoint(hiderPoint, places);
        const nearestSeekerTrainStation = turf.nearestPoint(
            seekerPoint,
            places,
        );

        if (question.type === "same-train-line") {
            const nodes = await trainLineNodeFinder(
                nearestSeekerTrainStation.properties.id,
            );

            const hiderId = parseInt(
                nearestHiderTrainStation.properties.id.split("/")[1],
            );

            if (nodes.includes(hiderId)) {
                question.same = true;
            } else {
                question.same = false;
            }
        }

        const hiderEnglishName =
            nearestHiderTrainStation.properties["name:en"] ||
            nearestHiderTrainStation.properties.name;
        const seekerEnglishName =
            nearestSeekerTrainStation.properties["name:en"] ||
            nearestSeekerTrainStation.properties.name;

        if (!hiderEnglishName || !seekerEnglishName) {
            return question;
        }

        if (question.type === "same-first-letter-station") {
            if (
                hiderEnglishName[0].toUpperCase() ===
                seekerEnglishName[0].toUpperCase()
            ) {
                question.same = true;
            } else {
                question.same = false;
            }
        } else if (question.type === "same-length-station") {
            if (hiderEnglishName.length === seekerEnglishName.length) {
                question.lengthComparison = "same";
            } else if (hiderEnglishName.length < seekerEnglishName.length) {
                question.lengthComparison = "shorter";
            } else {
                question.lengthComparison = "longer";
            }
        }

        return question;
    }

    const $mapGeoJSON = mapGeoJSON.get();
    if ($mapGeoJSON === null) return question;

    // eslint-disable-next-line no-useless-assignment
    let feature = null;

    try {
        feature = holedMask((await adjustPerMatching(question, $mapGeoJSON))!);
    } catch {
        try {
            feature = await adjustPerMatching(question, {
                type: "FeatureCollection",
                features: [holedMask($mapGeoJSON)],
            });
        } catch {
            return question;
        }
    }

    if (feature === null || feature === undefined) return question;

    const hiderPoint = turf.point([$hiderMode.longitude, $hiderMode.latitude]);

    if (turf.booleanPointInPolygon(hiderPoint, feature)) {
        question.same = !question.same;
    }

    return question;
};

export const matchingPlanningPolygon = async (question: MatchingQuestion) => {
    try {
        const boundary = await determineMatchingBoundary(question);

        if (boundary === false) {
            return false;
        }

        return turf.polygonToLine(boundary);
    } catch {
        return false;
    }
};
