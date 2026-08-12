import * as turf from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import { describe, expect, it } from "vitest";

import { adminBorderFeatures } from "@/maps/questions/measuring";

const square = (west: number, south: number, size = 0.1) =>
    turf.polygon([
        [
            [west, south],
            [west + size, south],
            [west + size, south + size],
            [west, south + size],
            [west, south],
        ],
    ]) as Feature<Polygon>;

describe("adminBorderFeatures", () => {
    it("turns a zone polygon into a single line feature", () => {
        const features = adminBorderFeatures(square(-74, 40.7));

        expect(features).toHaveLength(1);
        expect(turf.getType(features[0]!)).toBe("LineString");
    });

    it("keeps the ring closed so distance is measured to the whole border", () => {
        const [border] = adminBorderFeatures(square(-74, 40.7));
        const coordinates = (border!.geometry as any).coordinates as number[][];

        expect(coordinates[0]).toEqual(coordinates[coordinates.length - 1]);
    });

    it("returns one feature per ring of a multi-part zone", () => {
        const multi = turf.multiPolygon([
            (square(-74, 40.7).geometry as Polygon).coordinates,
            (square(-73.5, 40.7).geometry as Polygon).coordinates,
        ]) as Feature<MultiPolygon>;

        const features = adminBorderFeatures(multi);

        expect(features).toHaveLength(2);
        for (const feature of features) {
            expect(turf.getType(feature)).toBe("LineString");
        }
    });

    it("measures distance from an inside point to the nearest edge", () => {
        // A point just inside the western edge is nearer that edge than the
        // eastern one, which is what the buffered answer relies on.
        const [border] = adminBorderFeatures(square(-74, 40.7));
        const inside = turf.point([-73.99, 40.75]);

        const distance = turf.pointToLineDistance(inside, border as any, {
            units: "miles",
        });

        expect(distance).toBeGreaterThan(0);
        expect(distance).toBeLessThan(1);
    });
});
