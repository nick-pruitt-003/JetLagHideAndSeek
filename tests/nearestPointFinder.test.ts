import * as turf from "@turf/turf";
import { describe, expect, it } from "vitest";

import { nearestPointFinder } from "@/maps/geo-utils/nearest";

describe("nearestPointFinder", () => {
    it("picks the same point as turf.nearestPoint", () => {
        let seed = 11;
        const rand = () => {
            seed = (seed * 16807) % 2147483647;
            return seed / 2147483647;
        };
        // NYC-area POIs, plus queries inside and well outside their spread.
        const pois = turf.featureCollection(
            Array.from({ length: 500 }, (_, i) =>
                turf.point([-74.3 + rand() * 0.7, 40.5 + rand() * 0.45], {
                    id: i,
                }),
            ),
        );
        const nearest = nearestPointFinder(pois);
        for (let i = 0; i < 500; i++) {
            const q = turf.point([-74.6 + rand() * 1.3, 40.2 + rand() * 1]);
            expect(nearest(q).properties.id).toBe(
                turf.nearestPoint(q, pois).properties.id,
            );
        }
    });

    it("breaks ties toward the earlier feature, like turf", () => {
        // The same place mapped more than once (an airport as a node and
        // again as a duplicate) gives exact distance ties. The k-d tree
        // alone returns an arbitrary copy — this seed produces cases where
        // it picks a later one.
        let seed = 9;
        const rand = () => {
            seed = (seed * 16807) % 2147483647;
            return seed / 2147483647;
        };
        for (let trial = 0; trial < 3000; trial++) {
            const n = 5 + Math.floor(rand() * 200);
            const coords = Array.from({ length: n }, () => [
                -74 + rand(),
                40 + rand(),
            ]);
            const src = coords[Math.floor(rand() * n)];
            const copies = 1 + Math.floor(rand() * 5);
            for (let k = 0; k < copies; k++) {
                coords.splice(Math.floor(rand() * coords.length), 0, [...src]);
            }
            const fc = turf.featureCollection(
                coords.map((c, i) => turf.point(c, { i })),
            );
            const q = turf.point([
                src[0] + (rand() - 0.5) * 0.01,
                src[1] + (rand() - 0.5) * 0.01,
            ]);
            expect(nearestPointFinder(fc)(q).properties.i).toBe(
                turf.nearestPoint(q, fc).properties.i,
            );
        }
    });

    it("accepts a bare [lng, lat] and ignores non-point features", () => {
        const fc = turf.featureCollection<any>([
            turf.lineString([
                [0, 0],
                [1, 1],
            ]),
            turf.point([10, 10], { id: "far" }),
            turf.point([0.1, 0.1], { id: "near" }),
        ]);
        expect(nearestPointFinder(fc)([0, 0]).properties?.id).toBe("near");
    });
});
