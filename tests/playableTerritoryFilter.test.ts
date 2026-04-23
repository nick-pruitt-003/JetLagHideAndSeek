import * as turf from "@turf/turf";
import { describe, expect, it } from "vitest";

import { filterOsmElementsToPlayableTerritory } from "@/maps/api/overpass";

describe("filterOsmElementsToPlayableTerritory", () => {
    const smallSquare = turf.polygon([
        [
            [-74.02, 40.68],
            [-73.92, 40.68],
            [-73.92, 40.78],
            [-74.02, 40.78],
            [-74.02, 40.68],
        ],
    ]);

    it("keeps all elements when territory is null", () => {
        const els = [
            { type: "node", id: 1, lat: 40.73, lon: -73.97 },
            { type: "node", id: 2, lat: 40.0, lon: -74.5 },
        ];
        expect(filterOsmElementsToPlayableTerritory(els, null)).toEqual(els);
    });

    it("drops elements whose center lies outside the territory", () => {
        const els = [
            {
                type: "node",
                id: 1,
                center: { lat: 40.73, lon: -73.97 },
            },
            {
                type: "node",
                id: 2,
                center: { lat: 40.73, lon: -72.0 },
            },
        ];
        const out = filterOsmElementsToPlayableTerritory(els, smallSquare);
        expect(out.map((e) => e.id)).toEqual([1]);
    });
});
