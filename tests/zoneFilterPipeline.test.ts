import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import { describe, expect, it } from "vitest";

import type { MatchedStation } from "@/lib/transit/osm-gtfs-match";
import type { TransitStop } from "@/lib/transit/types";
import type { StationCircle, StationPlace } from "@/maps/api";
import {
    applyQuestionFilters,
    buildCirclesFromPlaces,
    cullCirclesAgainstZone,
    filterCirclesByReachability,
    matchingFacilityCacheKey,
    playableBboxFromHoledMask,
    stationsSignature,
} from "@/maps/geo-utils/zonePipeline";
import type { Question } from "@/maps/schema";

// ---------------------------------------------------------------------------
// Fixtures — synthesized points clustered around NYC-ish coordinates. No
// network, no real OSM.
// ---------------------------------------------------------------------------

function mkPlace(
    id: string,
    lng: number,
    lat: number,
    name?: string,
): StationPlace {
    return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: { id, name },
    } as StationPlace;
}

// A small square-ish holed mask around (lat 40.75, lng -73.98): the outer
// ring spans the world and the inner ring is the playable region.
function mkHoledMask(
    playable: [number, number, number, number], // [minLng, minLat, maxLng, maxLat]
): FeatureCollection<Polygon> {
    const [w, s, e, n] = playable;
    const outer = [
        [-180, -90],
        [180, -90],
        [180, 90],
        [-180, 90],
        [-180, -90],
    ];
    const hole = [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
    ];
    return {
        type: "FeatureCollection",
        features: [
            {
                type: "Feature",
                properties: {},
                geometry: { type: "Polygon", coordinates: [outer, hole] },
            },
        ],
    };
}

// ---------------------------------------------------------------------------
// playableBboxFromHoledMask
// ---------------------------------------------------------------------------

describe("playableBboxFromHoledMask", () => {
    it("returns the bbox of the playable (hole) region, not the world", () => {
        const mask = mkHoledMask([-74.0, 40.7, -73.9, 40.8]);
        const bbox = playableBboxFromHoledMask(mask);
        expect(bbox).toEqual([-74.0, 40.7, -73.9, 40.8]);
    });

    it("returns null when the mask has no holes (nothing playable)", () => {
        const degenerate: FeatureCollection<Polygon> = {
            type: "FeatureCollection",
            features: [
                {
                    type: "Feature",
                    properties: {},
                    geometry: {
                        type: "Polygon",
                        coordinates: [
                            [
                                [-180, -90],
                                [180, -90],
                                [180, 90],
                                [-180, 90],
                                [-180, -90],
                            ],
                        ],
                    },
                },
            ],
        };
        expect(playableBboxFromHoledMask(degenerate)).toBeNull();
    });

    it("handles MultiPolygons and Features alongside FeatureCollections", () => {
        const mp: Feature = {
            type: "Feature",
            properties: {},
            geometry: {
                type: "MultiPolygon",
                coordinates: [
                    [
                        [
                            [-180, -90],
                            [180, -90],
                            [180, 90],
                            [-180, 90],
                            [-180, -90],
                        ],
                        [
                            [-74, 40],
                            [-73, 40],
                            [-73, 41],
                            [-74, 41],
                            [-74, 40],
                        ],
                    ],
                ],
            },
        };
        expect(playableBboxFromHoledMask(mp)).toEqual([-74, 40, -73, 41]);
    });

    it("returns null for null / undefined input", () => {
        expect(playableBboxFromHoledMask(null)).toBeNull();
        expect(playableBboxFromHoledMask(undefined)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// buildCirclesFromPlaces
// ---------------------------------------------------------------------------

describe("buildCirclesFromPlaces", () => {
    it("produces one circle per place, carries properties through", () => {
        const places = [
            mkPlace("node/1", -73.98, 40.75, "A"),
            mkPlace("node/2", -73.99, 40.76, "B"),
        ];
        const circles = buildCirclesFromPlaces(places, {
            radius: 0.5,
            units: "miles",
        });
        expect(circles).toHaveLength(2);
        for (const c of circles) {
            expect(c.geometry.type).toBe("Polygon");
            expect(c.properties.properties.id).toMatch(/node\//);
        }
    });

    it("honors the steps option for polygon resolution", () => {
        const circles = buildCirclesFromPlaces([mkPlace("node/1", 0, 0)], {
            radius: 1,
            units: "kilometers",
            steps: 8,
        });
        // turf.circle produces `steps + 1` coordinates (closed ring).
        expect(circles[0].geometry.coordinates[0].length).toBe(9);
    });
});

// ---------------------------------------------------------------------------
// cullCirclesAgainstZone
// ---------------------------------------------------------------------------

describe("cullCirclesAgainstZone", () => {
    const mask = mkHoledMask([-74.0, 40.7, -73.9, 40.8]);
    const unionized = mask.features[0] as Feature;
    const playableBbox = playableBboxFromHoledMask(mask);

    it("keeps circles that overlap the playable region", () => {
        const circles = buildCirclesFromPlaces(
            [mkPlace("inside", -73.95, 40.75)],
            { radius: 0.1, units: "miles" },
        );
        const kept = cullCirclesAgainstZone(circles, {
            playableBbox,
            unionizedMask: unionized,
            radiusKm: 0.1 * 1.609,
        });
        expect(kept).toHaveLength(1);
    });

    it("drops circles that are fully outside the playable bbox via the cheap prefilter", () => {
        // Far from the playable region; bbox prefilter should reject it.
        const circles = buildCirclesFromPlaces(
            [mkPlace("far", -120.0, 40.75)],
            { radius: 0.1, units: "miles" },
        );
        const kept = cullCirclesAgainstZone(circles, {
            playableBbox,
            unionizedMask: unionized,
            radiusKm: 0.1 * 1.609,
        });
        expect(kept).toHaveLength(0);
    });

    it("drops circles that pass the prefilter but are wholly in the mask", () => {
        // Inside the playable bbox but beyond the playable polygon — not
        // possible for a rectangular hole, so pick a circle just barely
        // outside the playable region's eastern edge.
        const circles = buildCirclesFromPlaces(
            [mkPlace("edge", -73.85, 40.75)],
            { radius: 0.1, units: "miles" },
        );
        const kept = cullCirclesAgainstZone(circles, {
            playableBbox,
            unionizedMask: unionized,
            radiusKm: 0.1 * 1.609,
        });
        // circle at -73.85 with ~0.16 km radius sits fully east of the
        // playable east edge at -73.9, which places it entirely in the
        // mask — should be dropped.
        expect(kept).toHaveLength(0);
    });

    it("returns empty when no playable region is provided", () => {
        const circles = buildCirclesFromPlaces([mkPlace("anywhere", 0, 0)], {
            radius: 1,
            units: "miles",
        });
        const kept = cullCirclesAgainstZone(circles, {
            playableBbox: null,
            unionizedMask: unionized,
            radiusKm: 1.609,
        });
        expect(kept).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// stationsSignature
// ---------------------------------------------------------------------------

describe("stationsSignature", () => {
    const build = (ids: string[]): StationCircle[] =>
        buildCirclesFromPlaces(
            ids.map((id) => mkPlace(id, 0, 0)),
            { radius: 0.5, units: "miles" },
        );

    it("is stable under reordering of the same station set", () => {
        const a = stationsSignature(build(["b", "a", "c"]), 0.5, "miles");
        const b = stationsSignature(build(["a", "b", "c"]), 0.5, "miles");
        expect(a).toBe(b);
    });

    it("changes when a station is added or removed", () => {
        const a = stationsSignature(build(["a", "b"]), 0.5, "miles");
        const b = stationsSignature(build(["a", "b", "c"]), 0.5, "miles");
        expect(a).not.toBe(b);
    });

    it("changes when the hiding radius changes", () => {
        const a = stationsSignature(build(["a"]), 0.5, "miles");
        const b = stationsSignature(build(["a"]), 1.0, "miles");
        expect(a).not.toBe(b);
    });
});

// ---------------------------------------------------------------------------
// applyQuestionFilters
// ---------------------------------------------------------------------------

describe("applyQuestionFilters", () => {
    const matchingZoneKey = "test-matching-zone";

    const build = (
        spec: Array<{ id: string; lng: number; lat: number; name?: string }>,
    ): StationCircle[] =>
        buildCirclesFromPlaces(
            spec.map((s) => mkPlace(s.id, s.lng, s.lat, s.name)),
            { radius: 0.25, units: "miles" },
        );

    it("is a no-op when no relevant questions are present", async () => {
        const circles = build([
            { id: "a", lng: -73.98, lat: 40.75, name: "Alpha" },
            { id: "b", lng: -73.99, lat: 40.76, name: "Beta" },
        ]);
        const out = await applyQuestionFilters({
            circles,
            questions: [],
            measuringPoiCache: new Map(),
            matchingZoneKey,
            hidingRadius: 0.25,
            useCustomStations: false,
            includeDefaultStations: true,
            planningModeEnabled: false,
        });
        expect(out).toHaveLength(2);
    });

    it("skips draggable questions when planning mode is enabled", async () => {
        const circles = build([
            { id: "a", lng: -73.98, lat: 40.75, name: "Alpha" },
            { id: "b", lng: -73.99, lat: 40.76, name: "Beta" },
        ]);
        const question = {
            id: "matching",
            key: 1,
            data: {
                type: "same-first-letter-station",
                lat: 40.75,
                lng: -73.98,
                same: true,
                drag: true,
                color: "black",
                collapsed: false,
            },
        } as unknown as Question;
        const out = await applyQuestionFilters({
            circles,
            questions: [question],
            measuringPoiCache: new Map(),
            matchingZoneKey,
            hidingRadius: 0.25,
            useCustomStations: false,
            includeDefaultStations: true,
            planningModeEnabled: true,
        });
        expect(out).toHaveLength(2);
    });

    it("filters by same-first-letter-station when names match", async () => {
        const circles = build([
            { id: "a", lng: -73.98, lat: 40.75, name: "Alpha" },
            { id: "b", lng: -73.99, lat: 40.76, name: "Beta" },
            { id: "c", lng: -74.0, lat: 40.77, name: "Apple" },
        ]);
        const question = {
            id: "matching",
            key: 1,
            data: {
                type: "same-first-letter-station",
                lat: 40.75,
                lng: -73.98,
                same: true,
                drag: false,
                color: "black",
                collapsed: false,
            },
        } as unknown as Question;
        const out = await applyQuestionFilters({
            circles,
            questions: [question],
            measuringPoiCache: new Map(),
            matchingZoneKey,
            hidingRadius: 0.25,
            useCustomStations: false,
            includeDefaultStations: true,
            planningModeEnabled: false,
        });
        const names = out
            .map((c) => c.properties.properties.name)
            .filter(Boolean);
        // Nearest to (40.75, -73.98) is "Alpha", so we keep names starting
        // with 'A'.
        expect(names.sort()).toEqual(["Alpha", "Apple"]);
    });

    it("filters by same-length-station 'longer'", async () => {
        const circles = build([
            { id: "a", lng: -73.98, lat: 40.75, name: "Ab" }, // 2
            { id: "b", lng: -73.99, lat: 40.76, name: "Beta" }, // 4
            { id: "c", lng: -74.0, lat: 40.77, name: "Gamma" }, // 5
        ]);
        const question = {
            id: "matching",
            key: 1,
            data: {
                type: "same-length-station",
                lat: 40.75,
                lng: -73.98,
                same: true,
                drag: false,
                lengthComparison: "longer",
                color: "black",
                collapsed: false,
            },
        } as unknown as Question;
        const out = await applyQuestionFilters({
            circles,
            questions: [question],
            measuringPoiCache: new Map(),
            matchingZoneKey,
            hidingRadius: 0.25,
            useCustomStations: false,
            includeDefaultStations: true,
            planningModeEnabled: false,
        });
        const names = out
            .map((c) => c.properties.properties.name)
            .filter(Boolean);
        expect(names.sort()).toEqual(["Beta", "Gamma"]);
    });

    it("applies a prefetched measuring POI cache for mcdonalds", async () => {
        // Two stations and two POIs. Seeker at (40.75, -73.98), its
        // nearest POI distance ~ 0.5 miles. `hiderCloser=true` keeps any
        // station whose distance to nearest POI is strictly less than
        // seekerDistance + hidingRadius.
        const circles = build([
            { id: "near", lng: -73.98, lat: 40.75, name: "Near" },
            { id: "far", lng: -73.0, lat: 40.1, name: "Far" },
        ]);
        const poiFC = turf.featureCollection([
            turf.point([-73.983, 40.75]), // ~0.15 mi from "near"
            turf.point([-73.0, 40.5]),
        ]);
        const cache = new Map([['["brand:wikidata"="Q38076"]', poiFC]]);
        const question = {
            id: "measuring",
            key: 1,
            data: {
                type: "mcdonalds",
                lat: 40.75,
                lng: -73.98,
                hiderCloser: true,
                drag: false,
                color: "black",
                collapsed: false,
            },
        } as unknown as Question;
        const out = await applyQuestionFilters({
            circles,
            questions: [question],
            measuringPoiCache: cache,
            matchingZoneKey,
            hidingRadius: 0.25,
            useCustomStations: false,
            includeDefaultStations: true,
            planningModeEnabled: false,
        });
        const ids = out.map((c) => c.properties.properties.id).sort();
        expect(ids).toEqual(["near"]);
    });

    it("filters airport matching by nearest commercial airport (Voronoi cell)", async () => {
        const hvn = turf.point([-72.999, 41.265]);
        const jfk = turf.point([-73.778, 40.641]);
        const airports = turf.featureCollection([hvn, jfk]);
        const airportQuestionData = {
            type: "airport" as const,
            lat: 41.25,
            lng: -72.95,
            same: false,
            activeOnly: false,
            drag: false,
            color: "black",
            collapsed: false,
        };
        const zoneKey = "fixture-overpass-zone";
        const key = matchingFacilityCacheKey(
            airportQuestionData as any,
            zoneKey,
        );
        const cache = new Map([[key, airports]]);

        const circles = build([
            { id: "near-hvn", lng: -72.99, lat: 41.27, name: "Near HVN" },
            { id: "near-jfk", lng: -73.9, lat: 40.7, name: "Near JFK" },
        ]);
        const question = {
            id: "matching",
            key: 1,
            data: airportQuestionData,
        } as unknown as Question;

        const out = await applyQuestionFilters({
            circles,
            questions: [question],
            measuringPoiCache: new Map(),
            matchingFacilityCache: cache,
            matchingZoneKey: zoneKey,
            hidingRadius: 0.25,
            useCustomStations: false,
            includeDefaultStations: true,
            planningModeEnabled: false,
        });
        expect(out.map((c) => c.properties.properties.id).sort()).toEqual([
            "near-jfk",
        ]);

        const outSame = await applyQuestionFilters({
            circles,
            questions: [
                {
                    ...question,
                    data: { ...airportQuestionData, same: true },
                } as Question,
            ],
            measuringPoiCache: new Map(),
            matchingFacilityCache: cache,
            matchingZoneKey: zoneKey,
            hidingRadius: 0.25,
            useCustomStations: false,
            includeDefaultStations: true,
            planningModeEnabled: false,
        });
        expect(outSame.map((c) => c.properties.properties.id).sort()).toEqual([
            "near-hvn",
        ]);
    });

    it("classifies airport matching by station center, not circle overlap", async () => {
        const hvn = turf.point([-72.999, 41.265]);
        const jfk = turf.point([-73.778, 40.641]);
        const airports = turf.featureCollection([hvn, jfk]);
        const airportQuestionData = {
            type: "airport" as const,
            lat: 41.25,
            lng: -72.95,
            same: false,
            activeOnly: false,
            drag: false,
            color: "black",
            collapsed: false,
        };
        const zoneKey = "fixture-overpass-zone";
        const key = matchingFacilityCacheKey(
            airportQuestionData as any,
            zoneKey,
        );
        const cache = new Map([[key, airports]]);

        // Large radius intentionally makes circles overlap across Voronoi border.
        // We still want strict nearest-airport classification by station center.
        const circles = build([
            { id: "near-hvn", lng: -72.99, lat: 41.27, name: "Near HVN" },
            { id: "near-jfk", lng: -73.9, lat: 40.7, name: "Near JFK" },
        ]).map((c) => {
            const center = c.properties.geometry.coordinates;
            return {
                ...turf.circle([center[0], center[1]], 25, { units: "miles" }),
                properties: c.properties,
            } as StationCircle;
        });
        const question = {
            id: "matching",
            key: 1,
            data: airportQuestionData,
        } as unknown as Question;

        const outDifferent = await applyQuestionFilters({
            circles,
            questions: [question],
            measuringPoiCache: new Map(),
            matchingFacilityCache: cache,
            matchingZoneKey: zoneKey,
            hidingRadius: 25,
            useCustomStations: false,
            includeDefaultStations: true,
            planningModeEnabled: false,
        });
        expect(
            outDifferent.map((c) => c.properties.properties.id).sort(),
        ).toEqual(["near-jfk"]);

        const outSame = await applyQuestionFilters({
            circles,
            questions: [
                {
                    ...question,
                    data: { ...airportQuestionData, same: true },
                } as Question,
            ],
            measuringPoiCache: new Map(),
            matchingFacilityCache: cache,
            matchingZoneKey: zoneKey,
            hidingRadius: 25,
            useCustomStations: false,
            includeDefaultStations: true,
            planningModeEnabled: false,
        });
        expect(outSame.map((c) => c.properties.properties.id).sort()).toEqual([
            "near-hvn",
        ]);
    });

    it("matchingFacilityCacheKey for airport includes sorted disabled IATA list", () => {
        const base = {
            type: "airport" as const,
            lat: 0,
            lng: 0,
            same: true,
            activeOnly: false,
            drag: false,
            color: "black" as const,
            collapsed: false,
            disabledAirportIatas: [] as string[],
        };
        const zoneKey = "z";
        const empty = matchingFacilityCacheKey(base as any, zoneKey);
        const withTeb = matchingFacilityCacheKey(
            { ...base, disabledAirportIatas: ["TEB"] } as any,
            zoneKey,
        );
        expect(empty).not.toBe(withTeb);
        const ab = matchingFacilityCacheKey(
            { ...base, disabledAirportIatas: ["FRG", "TEB"] } as any,
            zoneKey,
        );
        const ba = matchingFacilityCacheKey(
            { ...base, disabledAirportIatas: ["TEB", "FRG"] } as any,
            zoneKey,
        );
        expect(ab).toBe(ba);
    });

    it("matchingFacilityCacheKey for major-city includes sorted disabled OSM refs", () => {
        const base = {
            type: "major-city" as const,
            lat: 0,
            lng: 0,
            same: true,
            drag: false,
            color: "black" as const,
            collapsed: false,
            disabledFacilityOsmRefs: [] as string[],
        };
        const zoneKey = "z";
        const a = matchingFacilityCacheKey(base as any, zoneKey);
        const b = matchingFacilityCacheKey(
            { ...base, disabledFacilityOsmRefs: ["node/1", "way/2"] } as any,
            zoneKey,
        );
        expect(a).not.toBe(b);
    });

    it("returns the same circles when measuring cache misses for an mcdonalds question", async () => {
        const circles = build([
            { id: "a", lng: -73.98, lat: 40.75, name: "Alpha" },
        ]);
        const question = {
            id: "measuring",
            key: 1,
            data: {
                type: "mcdonalds",
                lat: 40.75,
                lng: -73.98,
                hiderCloser: true,
                drag: false,
                color: "black",
                collapsed: false,
            },
        } as unknown as Question;
        const out = await applyQuestionFilters({
            circles,
            questions: [question],
            measuringPoiCache: new Map(),
            matchingZoneKey,
            hidingRadius: 0.25,
            useCustomStations: false,
            includeDefaultStations: true,
            planningModeEnabled: false,
        });
        expect(out).toHaveLength(1);
    });

    it("skips 'same-train-line' for custom-only station lists but keeps unrelated matching filters", async () => {
        let warned = 0;
        const fakeToast = {
            warning: () => {
                warned += 1;
            },
            error: () => {},
        } as unknown as Parameters<typeof applyQuestionFilters>[0]["toast"];

        const circles = build([
            { id: "custom/a", lng: -73.98, lat: 40.75, name: "Alpha" },
            { id: "custom/b", lng: -73.99, lat: 40.76, name: "Alice" },
        ]);
        const question = {
            id: "matching",
            key: 1,
            data: {
                type: "same-train-line",
                lat: 40.75,
                lng: -73.98,
                same: true,
                drag: false,
                color: "black",
                collapsed: false,
            },
        } as unknown as Question;
        const out = await applyQuestionFilters({
            circles,
            questions: [question],
            measuringPoiCache: new Map(),
            matchingZoneKey,
            hidingRadius: 0.25,
            useCustomStations: true,
            includeDefaultStations: false,
            planningModeEnabled: false,
            toast: fakeToast,
        });
        // With custom-only lists, the train-line branch is skipped; the
        // outer code then checks the englishName and returns current.
        // Both stations should remain.
        expect(out).toHaveLength(2);
        expect(warned).toBe(1);
    });

    it("uses the injected resolveTrainLineNodes for same-train-line", async () => {
        const circles = build([
            { id: "node/100", lng: -73.98, lat: 40.75, name: "A" },
            { id: "node/200", lng: -73.99, lat: 40.76, name: "B" },
            { id: "node/300", lng: -74.0, lat: 40.77, name: "C" },
        ]);
        const question = {
            id: "matching",
            key: 1,
            data: {
                type: "same-train-line",
                lat: 40.75,
                lng: -73.98,
                same: true,
                drag: false,
                color: "black",
                collapsed: false,
            },
        } as unknown as Question;
        const out = await applyQuestionFilters({
            circles,
            questions: [question],
            measuringPoiCache: new Map(),
            matchingZoneKey,
            hidingRadius: 0.25,
            useCustomStations: false,
            includeDefaultStations: true,
            planningModeEnabled: false,
            resolveTrainLineNodes: async () => ({
                nodeIds: [100, 200],
                stops: [],
            }),
        });
        const ids = out.map((c) => c.properties.properties.id).sort();
        expect(ids).toEqual(["node/100", "node/200"]);
    });
});

// ---------------------------------------------------------------------------
// filterCirclesByReachability
// ---------------------------------------------------------------------------

describe("filterCirclesByReachability", () => {
    const build = (
        pts: { id: string; lng: number; lat: number; name?: string }[],
    ) =>
        buildCirclesFromPlaces(
            pts.map((p) => mkPlace(p.id, p.lng, p.lat, p.name)),
            { radius: 0.25, units: "miles" },
        );

    function mkStop(
        id: string,
        systemId = "nyct",
        locationType = 1,
        parentStopId?: string,
    ): TransitStop {
        return {
            id,
            systemId,
            gtfsStopId: id.split(":")[1] ?? id,
            name: id,
            lat: 0,
            lng: 0,
            locationType,
            parentStopId,
        };
    }

    function mkMatch(osmId: string, stopId: string | null): MatchedStation {
        if (!stopId) return { osmId, best: null, alternatives: [] };
        return {
            osmId,
            best: {
                stopId,
                systemId: stopId.split(":")[0],
                name: stopId,
                distanceMeters: 10,
                nameSimilarity: 1,
                score: 1,
                method: "gtfs_ref",
            },
            alternatives: [],
        };
    }

    it("keeps reachable, drops unreachable, keeps unknown by default", () => {
        const circles = build([
            { id: "node/1", lng: 0, lat: 0 },
            { id: "node/2", lng: 0, lat: 0 },
            { id: "node/3", lng: 0, lat: 0 },
        ]);
        const matches = new Map<string, MatchedStation>([
            ["node/1", mkMatch("node/1", "nyct:A")],
            ["node/2", mkMatch("node/2", "nyct:B")],
            ["node/3", mkMatch("node/3", null)], // unknown
        ]);
        const stopById = new Map<string, TransitStop>([
            ["nyct:A", mkStop("nyct:A")],
            ["nyct:B", mkStop("nyct:B")],
        ]);
        const arrivals = new Map<string, number>([
            ["nyct:A", 5 * 60], // reachable in 5min
            ["nyct:B", 45 * 60], // >30 min budget → unreachable
        ]);
        const { filtered, classifications } = filterCirclesByReachability({
            circles,
            matches,
            arrivalsByStopId: arrivals,
            stopById,
            budgetMinutes: 30,
        });
        const ids = filtered.map((c) => c.properties.properties.id).sort();
        expect(ids).toEqual(["node/1", "node/3"]);
        expect(classifications.get("node/1")).toBe("reachable");
        expect(classifications.get("node/2")).toBe("unreachable");
        expect(classifications.get("node/3")).toBe("unknown");
    });

    it("drops unknown when unknownDefault=exclude", () => {
        const circles = build([{ id: "node/1", lng: 0, lat: 0 }]);
        const matches = new Map([["node/1", mkMatch("node/1", null)]]);
        const { filtered } = filterCirclesByReachability({
            circles,
            matches,
            arrivalsByStopId: new Map(),
            stopById: new Map(),
            budgetMinutes: 30,
            unknownDefault: "exclude",
        });
        expect(filtered).toHaveLength(0);
    });

    it("respects include override for unreachable stations", () => {
        const circles = build([{ id: "node/1", lng: 0, lat: 0 }]);
        const matches = new Map([["node/1", mkMatch("node/1", "nyct:A")]]);
        const stopById = new Map([["nyct:A", mkStop("nyct:A")]]);
        const overrides = new Map<string, "include" | "exclude">([
            ["node/1", "include"],
        ]);
        const { filtered } = filterCirclesByReachability({
            circles,
            matches,
            arrivalsByStopId: new Map(), // no arrivals → unreachable
            stopById,
            budgetMinutes: 30,
            overrides,
        });
        expect(filtered).toHaveLength(1);
    });

    it("respects exclude override even when reachable", () => {
        const circles = build([{ id: "node/1", lng: 0, lat: 0 }]);
        const matches = new Map([["node/1", mkMatch("node/1", "nyct:A")]]);
        const stopById = new Map([["nyct:A", mkStop("nyct:A")]]);
        const { filtered } = filterCirclesByReachability({
            circles,
            matches,
            arrivalsByStopId: new Map([["nyct:A", 60]]),
            stopById,
            budgetMinutes: 30,
            overrides: new Map([["node/1", "exclude"]]),
        });
        expect(filtered).toHaveLength(0);
    });

    it("uses parent-station fallback when match points at a platform", () => {
        const circles = build([{ id: "node/1", lng: 0, lat: 0 }]);
        // The match resolves to a platform (location_type=0) but only
        // the parent station has an arrival entry. The lookup should
        // roll up and count it reachable.
        const matches = new Map([["node/1", mkMatch("node/1", "nyct:Plat")]]);
        const stopById = new Map([
            ["nyct:Plat", mkStop("nyct:Plat", "nyct", 0, "nyct:Parent")],
            ["nyct:Parent", mkStop("nyct:Parent", "nyct", 1)],
        ]);
        const arrivals = new Map([["nyct:Parent", 5 * 60]]);
        const { filtered, classifications } = filterCirclesByReachability({
            circles,
            matches,
            arrivalsByStopId: arrivals,
            stopById,
            budgetMinutes: 30,
        });
        expect(filtered).toHaveLength(1);
        expect(classifications.get("node/1")).toBe("reachable");
    });
});
