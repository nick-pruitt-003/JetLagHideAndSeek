import * as turf from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import _ from "lodash";
import {
    hiderMode,
    mapGeoJSON,
    mapGeoLocation,
    playableTerritoryUnion,
    polyGeoJSON,
    trainStations,
} from "@/lib/context";
import {
    fetchCoastline,
    findPlacesInZone,
    findPlacesSpecificInZone,
    nearestToQuestion,
    overpassAirportIataFilter,
    OVERPASS_MAJOR_CITY_FILTER,
    prettifyLocation,
    QuestionSpecificLocation,
} from "@/maps/api";
import {
    fetchFullFacilityElements,
    filterFacilityPointsByDisabledOsmRefs,
    osmElementsToFacilityPoints,
    validateFullFacilityFetch,
} from "@/maps/questions/facility-full";
import osmtogeojson from "@/maps/api/osm-to-geojson";
import {
    arcBufferToPoint,
    connectToSeparateLines,
    groupObjects,
    holedMask,
    modifyMapData,
} from "@/maps/geo-utils";
import type {
    APILocations,
    HomeGameMeasuringQuestions,
    MeasuringQuestion,
    MeasuringQuestionWithFacilityOsmRefs,
} from "@/maps/schema";

const highSpeedBase = _.memoize(
    (features: Feature[]) => {
        const grouped = groupObjects(features);

        const neighbored = grouped
            .map((group) => {
                return turf.multiLineString(
                    connectToSeparateLines(
                        group
                            .filter((x) => turf.getType(x) === "LineString")
                            .map((x) => x.geometry.coordinates),
                    ),
                );
            })
            .filter((x) => x.geometry.coordinates.length > 0);

        return turf.combine(
            turf.buffer(
                turf.simplify(turf.featureCollection(neighbored), {
                    tolerance: 0.001,
                }),
                0.001,
            )!,
        ).features[0];
    },
    (features) => `${JSON.stringify(features.map((x) => x.geometry))}`,
);

const bboxExtension = (
    bBox: [number, number, number, number],
    distance: number,
): [number, number, number, number] => {
    const buffered = turf.bbox(
        turf.buffer(turf.bboxPolygon(bBox), Math.abs(distance), {
            units: "miles",
        })!,
    );

    const originalDeltaLat = bBox[3] - bBox[1];
    const originalDeltaLng = bBox[2] - bBox[0];

    return [
        buffered[0] - originalDeltaLng,
        buffered[1] - originalDeltaLat,
        buffered[2] + originalDeltaLng,
        buffered[3] + originalDeltaLat,
    ];
};

export const determineMeasuringBoundary = async (
    question: MeasuringQuestion,
) => {
    const bBox = turf.bbox(mapGeoJSON.get()!);

    switch (question.type) {
        case "highspeed-measure-shinkansen": {
            const features = osmtogeojson(
                await findPlacesInZone(
                    "[highspeed=yes]",
                    "Finding high-speed lines...",
                    "nwr",
                    "geom",
                ),
            ).features;

            return [highSpeedBase(features)];
        }
        case "coastline": {
            const coastline = turf.lineToPolygon(
                await fetchCoastline(),
            ) as Feature<MultiPolygon>;

            const distanceToCoastline = turf.pointToPolygonDistance(
                turf.point([question.lng, question.lat]),
                coastline,
                {
                    units: "miles",
                    method: "geodesic",
                },
            );

            return [
                turf.difference(
                    turf.featureCollection([
                        turf.bboxPolygon(bBox),
                        turf.buffer(
                            turf.bboxClip(
                                coastline,
                                bBox
                                    ? bboxExtension(
                                          bBox as any,
                                          distanceToCoastline,
                                      )
                                    : [-180, -90, 180, 90],
                            ),
                            distanceToCoastline,
                            {
                                units: "miles",
                                steps: 64,
                            },
                        )!,
                    ]),
                )!,
            ];
        }
        case "airport":
            return [
                turf.combine(
                    turf.featureCollection(
                        _.uniqBy(
                            (
                                await findPlacesInZone(
                                    overpassAirportIataFilter(),
                                    "Finding airports...",
                                    "nwr",
                                    "center",
                                    [],
                                    240,
                                )
                            ).elements,
                            (feature: any) => feature.tags.iata,
                        ).map((x: any) =>
                            turf.point([
                                x.center ? x.center.lon : x.lon,
                                x.center ? x.center.lat : x.lat,
                            ]),
                        ),
                    ),
                ).features[0],
            ];
        case "city": {
            const cityData = await findPlacesInZone(
                OVERPASS_MAJOR_CITY_FILTER,
                "Finding cities...",
            );
            const pts = osmElementsToFacilityPoints(cityData.elements ?? []);
            const filtered = filterFacilityPointsByDisabledOsmRefs(
                pts,
                (question as MeasuringQuestionWithFacilityOsmRefs)
                    .disabledFacilityOsmRefs,
            );
            if (filtered.length === 0) {
                return [turf.multiPolygon([])];
            }
            return [
                turf.combine(turf.featureCollection(filtered)).features[0],
            ];
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
                return [turf.multiPolygon([])];
            }
            const pts = osmElementsToFacilityPoints(elements);
            const filtered = filterFacilityPointsByDisabledOsmRefs(
                pts,
                (question as MeasuringQuestionWithFacilityOsmRefs)
                    .disabledFacilityOsmRefs,
            );
            if (filtered.length === 0) {
                return [turf.multiPolygon([])];
            }
            return [
                turf.combine(turf.featureCollection(filtered)).features[0],
            ];
        }
        case "custom-measure":
            return turf.combine(
                turf.featureCollection((question as any).geo.features),
            ).features;
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
        case "mcdonalds":
        case "seven11":
        case "rail-measure":
            return false;
    }
};

const bufferedDeterminer = _.memoize(
    async (question: MeasuringQuestion) => {
        const placeData = await determineMeasuringBoundary(question);

        if (placeData === false || placeData === undefined) return false;

        return arcBufferToPoint(
            turf.featureCollection(placeData as any),
            question.lat,
            question.lng,
        );
    },
    (question) => {
        const ptu = playableTerritoryUnion.get();
        const playableDigest =
            ptu?.geometry != null
                ? turf
                      .bbox(ptu as Feature<Polygon | MultiPolygon>)
                      .map((x: number) => x.toFixed(4))
                      .join(",")
                : undefined;
        const mRefs = (question as MeasuringQuestionWithFacilityOsmRefs)
            .disabledFacilityOsmRefs;
        const facilityOsmExtras =
            question.type === "city" ||
            (typeof question.type === "string" &&
                question.type.endsWith("-full"))
                ? {
                      disabledFacilityOsmRefs: [...(mRefs ?? [])]
                          .map((s) => s.trim().toLowerCase())
                          .filter(Boolean)
                          .sort(),
                  }
                : {};
        return JSON.stringify({
            type: question.type,
            lat: question.lat,
            lng: question.lng,
            entirety: polyGeoJSON.get()
                ? polyGeoJSON.get()
                : mapGeoLocation.get(),
            playableDigest,
            geo: (question as any).geo,
            ...facilityOsmExtras,
        });
    },
);

export const adjustPerMeasuring = async (
    question: MeasuringQuestion,
    mapData: any,
) => {
    if (mapData === null) return;

    const buffer = await bufferedDeterminer(question);

    if (buffer === false) return mapData;

    return modifyMapData(mapData, buffer, question.hiderCloser);
};

export const hiderifyMeasuring = async (question: MeasuringQuestion) => {
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
            question as HomeGameMeasuringQuestions,
        );
        const hiderNearest = await nearestToQuestion({
            lat: $hiderMode.latitude,
            lng: $hiderMode.longitude,
            hiderCloser: true,
            type: (question as HomeGameMeasuringQuestions).type,
            drag: false,
            color: "black",
            collapsed: false,
        });

        question.hiderCloser =
            questionNearest.properties.distanceToPoint >
            hiderNearest.properties.distanceToPoint;

        return question;
    }

    if (question.type === "rail-measure") {
        const stations = trainStations.get();

        if (stations.length === 0) {
            return question;
        }

        const location = turf.point([question.lng, question.lat]);

        const nearestTrainStation = turf.nearestPoint(
            location,
            turf.featureCollection(stations.map((x) => x.properties)),
        );

        const distance = turf.distance(location, nearestTrainStation);

        const hider = turf.point([$hiderMode.longitude, $hiderMode.latitude]);

        const hiderNearest = turf.nearestPoint(
            hider,
            turf.featureCollection(stations.map((x) => x.properties)),
        );

        const hiderDistance = turf.distance(hider, hiderNearest);

        question.hiderCloser = hiderDistance < distance;
    }

    if (question.type === "mcdonalds" || question.type === "seven11") {
        const points = await findPlacesSpecificInZone(
            question.type === "mcdonalds"
                ? QuestionSpecificLocation.McDonalds
                : QuestionSpecificLocation.Seven11,
        );

        const seeker = turf.point([question.lng, question.lat]);
        const nearest = turf.nearestPoint(seeker, points as any);

        const distance = turf.distance(seeker, nearest, {
            units: "miles",
        });

        const hider = turf.point([$hiderMode.longitude, $hiderMode.latitude]);
        const hiderNearest = turf.nearestPoint(hider, points as any);

        const hiderDistance = turf.distance(hider, hiderNearest, {
            units: "miles",
        });

        question.hiderCloser = hiderDistance < distance;
        return question;
    }

    const $mapGeoJSON = mapGeoJSON.get();
    if ($mapGeoJSON === null) return question;

    // eslint-disable-next-line no-useless-assignment
    let feature = null;

    try {
        feature = holedMask((await adjustPerMeasuring(question, $mapGeoJSON))!);
    } catch {
        try {
            feature = await adjustPerMeasuring(question, {
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
        question.hiderCloser = !question.hiderCloser;
    }

    return question;
};

export const measuringPlanningPolygon = async (question: MeasuringQuestion) => {
    try {
        const buffered = await bufferedDeterminer(question);

        if (buffered === false) return false;

        return turf.polygonToLine(buffered);
    } catch {
        return false;
    }
};
