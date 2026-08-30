import { describe, expect, it } from "vitest";

import type { BusStopWithLines } from "@/maps/api/overpass";
import type { StationPlace } from "@/maps/api/types";
import {
    BUS_HUB_MIN_LINES,
    buildBusHubComplexes,
} from "@/maps/geo-utils/busHubs";

// ~0.1 mi of latitude / ~0.25 mi of latitude in degrees.
const MI_LAT = 1 / 69;

const stop = (
    id: number,
    lat: number,
    lon: number,
    lines: string[],
    name?: string,
): BusStopWithLines => ({ id: `node/${id}`, lat, lon, name, lines });

const railStation = (lat: number, lon: number): StationPlace => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: { id: "node/999", name: "Some Station" },
});

describe("buildBusHubComplexes", () => {
    it("pools lines across stops clustered within 0.2 mi", () => {
        const stops = [
            stop(1, 40.7, -73.9, ["B1", "B2", "B3"], "Main St"),
            stop(2, 40.7 + 0.1 * MI_LAT, -73.9, ["B4", "B5"]),
        ];
        const hubs = buildBusHubComplexes(stops, []);
        expect(hubs).toHaveLength(1);
        expect(hubs[0].properties.name).toContain("Main St");
        expect(hubs[0].properties.name).toContain("5 lines");
        expect(hubs[0].properties.id).toBe("bushub/1");
    });

    it("counts a line once even when several stops serve it", () => {
        const shared = ["B1", "B2", "B3", "B4"];
        const stops = [
            stop(1, 40.7, -73.9, shared),
            stop(2, 40.7 + 0.05 * MI_LAT, -73.9, shared),
        ];
        expect(buildBusHubComplexes(stops, [])).toHaveLength(0);
    });

    it("drops clusters below the minimum line count", () => {
        const stops = [stop(1, 40.7, -73.9, ["B1", "B2", "B3", "B4"])];
        expect(BUS_HUB_MIN_LINES).toBe(5);
        expect(buildBusHubComplexes(stops, [])).toHaveLength(0);
    });

    it("does not chain-cluster stops farther than 0.2 mi apart", () => {
        // Two 3-line stops 0.5 mi apart: separate clusters, neither
        // reaches 5 lines.
        const stops = [
            stop(1, 40.7, -73.9, ["B1", "B2", "B3"]),
            stop(2, 40.7 + 0.5 * MI_LAT, -73.9, ["B4", "B5", "B6"]),
        ];
        expect(buildBusHubComplexes(stops, [])).toHaveLength(0);
    });

    it("excludes hubs within 0.25 mi of a rail station", () => {
        const stops = [stop(1, 40.7, -73.9, ["B1", "B2", "B3", "B4", "B5"])];
        const nearRail = [railStation(40.7 + 0.2 * MI_LAT, -73.9)];
        const farRail = [railStation(40.7 + 0.5 * MI_LAT, -73.9)];
        expect(buildBusHubComplexes(stops, nearRail)).toHaveLength(0);
        expect(buildBusHubComplexes(stops, farRail)).toHaveLength(1);
    });
});
