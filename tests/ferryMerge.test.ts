import * as turf from "@turf/turf";
import { describe, expect, it } from "vitest";

import type { StationPlace } from "@/maps/api";
import { mergeNearbyFerryDocks } from "@/maps/geo-utils/stationManipulations";

const place = (
    id: string,
    name: string,
    lat: number,
    lng: number,
    tags: Record<string, string> = { amenity: "ferry_terminal" },
) => turf.point([lng, lat], { id, name, ...tags }) as StationPlace;

// Real OSM positions, Lower Manhattan / Governors Island.
const soissons = place(
    "node/9287986227",
    "Soissons Landing",
    40.69301,
    -74.01531,
);
const govIsland = place(
    "node/2405699093",
    "Governors Island",
    40.69327,
    -74.01529,
);
const yankeePier = place("node/3351139473", "Yankee Pier", 40.68677, -74.0165);
const whitehallWay = place(
    "way/38868195",
    "Staten Island Ferry Whitehall Terminal",
    40.70096,
    -74.01306,
);
const whitehallNode = place("node/701654214", "Whitehall", 40.70055, -74.01303);
const batteryMaritime = place(
    "node/701654537",
    "Battery Maritime Building",
    40.7008,
    -74.01161,
);
const southFerrySubway = place("node/1", "South Ferry", 40.7015, -74.0137, {
    railway: "station",
});

const names = (places: StationPlace[]) =>
    places.map((p) => p.properties.name).sort();

describe("mergeNearbyFerryDocks", () => {
    const merged = mergeNearbyFerryDocks([
        soissons,
        govIsland,
        yankeePier,
        whitehallWay,
        whitehallNode,
        batteryMaritime,
        southFerrySubway,
    ]);

    it("merges the same dock mapped twice under different names", () => {
        expect(names(merged)).toEqual([
            "Battery Maritime Building",
            "Soissons Landing",
            "South Ferry",
            "Staten Island Ferry Whitehall Terminal",
            "Yankee Pier",
        ]);
    });

    it("keeps the terminal building (way) over the node", () => {
        const whitehall = merged.find((p) =>
            p.properties.name?.includes("Whitehall"),
        )!;
        expect(whitehall.properties.id).toBe("way/38868195");
    });

    it("never touches non-ferry places, even right next to a dock", () => {
        expect(merged).toContain(southFerrySubway);
    });

    it("keeps genuinely separate terminals 120 m apart", () => {
        expect(names(merged)).toContain("Battery Maritime Building");
    });
});
