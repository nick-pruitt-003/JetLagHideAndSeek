import { describe, it, expect } from "vitest";

import {
    buildStopIndex,
    lookupArrivalWithParentFallback,
    matchOsmToGtfs,
    nameSimilarity,
    normalizeStationName,
    rollUpToParent,
    type OsmStationInput,
} from "../src/lib/transit/osm-gtfs-match";
import type { TransitStop } from "../src/lib/transit/types";

// ---------------------------------------------------------------------------
// Fixtures — synthesized NYC-flavored data. Coordinates are close to real
// values but nothing here hits the network.
// ---------------------------------------------------------------------------

const timesSqPlatform: TransitStop = {
    id: "nyct:127N",
    systemId: "nyct",
    gtfsStopId: "127N",
    name: "Times Sq - 42 St",
    lat: 40.75529,
    lng: -73.98765,
    locationType: 0,
    parentStopId: "nyct:127",
};

const timesSqParent: TransitStop = {
    id: "nyct:127",
    systemId: "nyct",
    gtfsStopId: "127",
    name: "Times Sq - 42 St",
    lat: 40.75529,
    lng: -73.98765,
    locationType: 1,
};

const grandCentralParent: TransitStop = {
    id: "nyct:631",
    systemId: "nyct",
    gtfsStopId: "631",
    name: "Grand Central - 42 St",
    lat: 40.75172,
    lng: -73.97644,
    locationType: 1,
};

const grandCentralLirr: TransitStop = {
    id: "lirr:GCT",
    systemId: "lirr",
    gtfsStopId: "GCT",
    name: "Grand Central",
    lat: 40.7527,
    lng: -73.9772,
    locationType: 1,
};

const pennLirr: TransitStop = {
    id: "lirr:PSQ",
    systemId: "lirr",
    gtfsStopId: "PSQ",
    name: "Penn Station",
    lat: 40.75054,
    lng: -73.99353,
    locationType: 1,
};

const pennSubway: TransitStop = {
    id: "nyct:A27",
    systemId: "nyct",
    gtfsStopId: "A27",
    name: "34 St - Penn Station",
    lat: 40.75237,
    lng: -73.99308,
    locationType: 1,
};

// Random far-away stop to confirm spatial culling works.
const jfkAirtrain: TransitStop = {
    id: "jfk:AT1",
    systemId: "jfk",
    gtfsStopId: "AT1",
    name: "Howard Beach",
    lat: 40.66026,
    lng: -73.83041,
    locationType: 1,
};

// Entrance — should be filtered out of the index entirely.
const entranceNoise: TransitStop = {
    id: "nyct:ENT1",
    systemId: "nyct",
    gtfsStopId: "ENT1",
    name: "Times Sq Entrance",
    lat: 40.75529,
    lng: -73.98765,
    locationType: 2,
};

const allStops: TransitStop[] = [
    timesSqPlatform,
    timesSqParent,
    grandCentralParent,
    grandCentralLirr,
    pennLirr,
    pennSubway,
    jfkAirtrain,
    entranceNoise,
];

// ---------------------------------------------------------------------------
// normalizeStationName / nameSimilarity
// ---------------------------------------------------------------------------

describe("normalizeStationName", () => {
    it("strips ordinal suffixes on numbers", () => {
        expect(normalizeStationName("42nd St")).toEqual(["42"]);
        expect(normalizeStationName("1st Ave")).toEqual(["1"]);
        expect(normalizeStationName("23rd Street")).toEqual(["23"]);
    });

    it("drops noise tokens", () => {
        expect(normalizeStationName("Grand Central Terminal")).toEqual([
            "grand",
            "central",
        ]);
        expect(normalizeStationName("Times Square Station")).toEqual(["times"]);
    });

    it("handles hyphens as separators", () => {
        expect(normalizeStationName("34 St - Penn Station")).toEqual([
            "34",
            "penn",
        ]);
    });

    it("is case insensitive", () => {
        expect(normalizeStationName("TIMES SQ")).toEqual(["times"]);
    });

    it("returns empty for pure noise input", () => {
        expect(normalizeStationName("Station")).toEqual([]);
        expect(normalizeStationName("")).toEqual([]);
    });
});

describe("nameSimilarity", () => {
    it("treats word-order swaps as equivalent", () => {
        const a = "Times Sq - 42 St";
        const b = "42 St - Times Sq";
        expect(nameSimilarity(a, b)).toBe(1);
    });

    it("scores partial overlaps", () => {
        const sim = nameSimilarity(
            "Grand Central - 42 St",
            "Grand Central Terminal",
        );
        // {"grand","central","42"} vs {"grand","central"} -> 2/3
        expect(sim).toBeCloseTo(2 / 3, 3);
    });

    it("returns 0 for fully disjoint names", () => {
        expect(nameSimilarity("Times Sq", "Penn Station")).toBe(0);
    });

    it("returns 0 when either side normalizes to empty", () => {
        expect(nameSimilarity("Station", "Times Sq")).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// buildStopIndex
// ---------------------------------------------------------------------------

describe("buildStopIndex", () => {
    it("filters out non-station/non-platform location types", () => {
        const idx = buildStopIndex(allStops);
        expect(idx.byId.has(entranceNoise.id)).toBe(false);
        expect(idx.byId.has(timesSqParent.id)).toBe(true);
    });

    it("groups stops by raw GTFS id for crosswalk lookup", () => {
        const idx = buildStopIndex(allStops);
        expect(idx.byGtfsId.get("631")?.[0].id).toBe(grandCentralParent.id);
    });
});

// ---------------------------------------------------------------------------
// matchOsmToGtfs
// ---------------------------------------------------------------------------

describe("matchOsmToGtfs", () => {
    it("matches a colocated OSM station to its GTFS parent by name+distance", () => {
        const osm: OsmStationInput[] = [
            {
                osmId: "osm-1",
                name: "Times Square - 42nd Street",
                lat: 40.7553,
                lng: -73.9876,
            },
        ];
        const [m] = matchOsmToGtfs(osm, allStops);
        expect(m.best).not.toBeNull();
        expect(m.best?.stopId).toBe(timesSqParent.id); // parent preferred over platform
        expect(m.best?.method).toBe("heuristic");
        expect(m.best?.distanceMeters).toBeLessThan(20);
    });

    it("honors explicit gtfs:stop_id crosswalk tag", () => {
        const osm: OsmStationInput[] = [
            {
                osmId: "osm-gc-explicit",
                // Deliberately wrong name to prove the tag wins.
                name: "Some Unrelated Label",
                lat: 40.7527,
                lng: -73.9772,
                tags: { "gtfs:stop_id": "631" },
            },
        ];
        const [m] = matchOsmToGtfs(osm, allStops);
        expect(m.best?.stopId).toBe(grandCentralParent.id);
        expect(m.best?.method).toBe("gtfs_ref");
        expect(m.best?.score).toBe(1);
    });

    it("returns null best and empty alternatives when nothing is within radius", () => {
        const osm: OsmStationInput[] = [
            {
                osmId: "osm-nowhere",
                name: "Some Rural Stop",
                lat: 45,
                lng: -110,
            },
        ];
        const [m] = matchOsmToGtfs(osm, allStops);
        expect(m.best).toBeNull();
        expect(m.alternatives).toHaveLength(0);
    });

    it("returns null best but populated alternatives on ambiguous match", () => {
        // Halfway between two systems' Penn stations — both within radius,
        // but name collides with neither.
        const osm: OsmStationInput[] = [
            {
                osmId: "osm-ambiguous",
                name: "Herald Square",
                lat: 40.75,
                lng: -73.993,
            },
        ];
        const [m] = matchOsmToGtfs(osm, allStops, { minScore: 0.8 });
        expect(m.best).toBeNull();
        expect(m.alternatives.length).toBeGreaterThan(0);
    });

    it("picks the better-named stop when two are equidistant (LIRR vs subway Penn)", () => {
        const osm: OsmStationInput[] = [
            {
                osmId: "osm-penn-lirr",
                name: "Penn Station",
                // Sits between the two feeds' stops.
                lat: 40.7515,
                lng: -73.9933,
            },
        ];
        const [m] = matchOsmToGtfs(osm, allStops);
        expect(m.best?.stopId).toBe(pennLirr.id);
        // Subway Penn should show up as an alternative.
        expect(m.alternatives.some((a) => a.stopId === pennSubway.id)).toBe(
            true,
        );
    });

    it("returns one result per input, in input order", () => {
        const osm: OsmStationInput[] = [
            { osmId: "a", name: "Times Sq", lat: 40.7553, lng: -73.9876 },
            { osmId: "b", name: "Grand Central", lat: 40.7517, lng: -73.9764 },
            { osmId: "c", name: "Penn", lat: 40.7524, lng: -73.9931 },
        ];
        const results = matchOsmToGtfs(osm, allStops);
        expect(results.map((r) => r.osmId)).toEqual(["a", "b", "c"]);
    });

    it("accepts a pre-built index", () => {
        const index = buildStopIndex(allStops);
        const osm: OsmStationInput[] = [
            { osmId: "osm-1", name: "Times Sq", lat: 40.7553, lng: -73.9876 },
        ];
        const [m] = matchOsmToGtfs(osm, index);
        expect(m.best?.stopId).toBe(timesSqParent.id);
    });
});

// ---------------------------------------------------------------------------
// rollUpToParent / lookupArrivalWithParentFallback
// ---------------------------------------------------------------------------

describe("rollUpToParent", () => {
    it("returns parent id for a platform with a known parent", () => {
        const { byId } = buildStopIndex(allStops);
        expect(rollUpToParent(timesSqPlatform.id, byId)).toBe(timesSqParent.id);
    });

    it("returns the id unchanged for a parent station", () => {
        const { byId } = buildStopIndex(allStops);
        expect(rollUpToParent(timesSqParent.id, byId)).toBe(timesSqParent.id);
    });

    it("returns the id unchanged when parent is unknown", () => {
        const orphan: TransitStop = {
            ...timesSqPlatform,
            id: "nyct:ORPHAN",
            gtfsStopId: "ORPHAN",
            parentStopId: "nyct:missing",
        };
        const { byId } = buildStopIndex([orphan]);
        expect(rollUpToParent("nyct:ORPHAN", byId)).toBe("nyct:ORPHAN");
    });
});

describe("lookupArrivalWithParentFallback", () => {
    it("returns direct arrival when present", () => {
        const { byId } = buildStopIndex(allStops);
        const arrivals = new Map([[timesSqPlatform.id, 600]]);
        expect(
            lookupArrivalWithParentFallback(
                timesSqPlatform.id,
                arrivals,
                byId,
            ),
        ).toBe(600);
    });

    it("falls back to parent arrival for a platform", () => {
        const { byId } = buildStopIndex(allStops);
        const arrivals = new Map([[timesSqParent.id, 420]]);
        expect(
            lookupArrivalWithParentFallback(
                timesSqPlatform.id,
                arrivals,
                byId,
            ),
        ).toBe(420);
    });

    it("falls back to child arrivals for a parent, picking the minimum", () => {
        const platformA: TransitStop = {
            ...timesSqPlatform,
            id: "nyct:127N",
            gtfsStopId: "127N",
            parentStopId: timesSqParent.id,
        };
        const platformB: TransitStop = {
            ...timesSqPlatform,
            id: "nyct:127S",
            gtfsStopId: "127S",
            parentStopId: timesSqParent.id,
        };
        const { byId } = buildStopIndex([timesSqParent, platformA, platformB]);
        const arrivals = new Map([
            [platformA.id, 900],
            [platformB.id, 720],
        ]);
        expect(
            lookupArrivalWithParentFallback(timesSqParent.id, arrivals, byId),
        ).toBe(720);
    });

    it("returns undefined when the stop and its relatives all have no arrival", () => {
        const { byId } = buildStopIndex(allStops);
        expect(
            lookupArrivalWithParentFallback(
                jfkAirtrain.id,
                new Map(),
                byId,
            ),
        ).toBeUndefined();
    });
});
