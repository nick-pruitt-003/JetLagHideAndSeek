import { describe, expect, it } from "vitest";

import { parseNominatimBoundaryPayload } from "@/maps/api/overpass";

describe("parseNominatimBoundaryPayload", () => {
    it("returns null for non-array input", () => {
        expect(parseNominatimBoundaryPayload(null)).toBeNull();
        expect(parseNominatimBoundaryPayload(undefined)).toBeNull();
        expect(parseNominatimBoundaryPayload({})).toBeNull();
        expect(parseNominatimBoundaryPayload("nope")).toBeNull();
    });

    it("returns null for an empty array", () => {
        expect(parseNominatimBoundaryPayload([])).toBeNull();
    });

    it("returns null when no entry has a polygon geometry", () => {
        // Nominatim returns an entry without `geojson` for node lookups
        // with `polygon_geojson=1` - we must treat that as "no boundary"
        // and let Overpass pick it up.
        expect(
            parseNominatimBoundaryPayload([
                { osm_id: 1, osm_type: "node" },
                {
                    osm_id: 2,
                    osm_type: "way",
                    geojson: { type: "Point", coordinates: [0, 0] },
                },
            ]),
        ).toBeNull();
    });

    it("wraps a single Polygon entry as a FeatureCollection", () => {
        const result = parseNominatimBoundaryPayload([
            {
                osm_id: 100,
                osm_type: "relation",
                geojson: {
                    type: "Polygon",
                    coordinates: [
                        [
                            [0, 0],
                            [1, 0],
                            [1, 1],
                            [0, 1],
                            [0, 0],
                        ],
                    ],
                },
            },
        ]);
        expect(result).not.toBeNull();
        expect(result!.type).toBe("FeatureCollection");
        expect(result!.features).toHaveLength(1);
        expect(result!.features[0].type).toBe("Feature");
        expect(result!.features[0].geometry.type).toBe("Polygon");
        expect(result!.features[0].properties.osm_id).toBe(100);
        expect(result!.features[0].properties.source).toBe("nominatim");
    });

    it("keeps MultiPolygon geometries verbatim (Japan / USA case)", () => {
        const multi = {
            type: "MultiPolygon" as const,
            coordinates: [
                [
                    [
                        [130, 30],
                        [145, 30],
                        [145, 45],
                        [130, 45],
                        [130, 30],
                    ],
                ],
            ],
        };
        const result = parseNominatimBoundaryPayload([
            { osm_id: 382313, osm_type: "relation", geojson: multi },
        ]);
        expect(result!.features[0].geometry).toEqual(multi);
    });

    it("skips bogus entries and keeps real ones (real-world mixed payload)", () => {
        const good = {
            type: "Polygon" as const,
            coordinates: [
                [
                    [0, 0],
                    [1, 0],
                    [1, 1],
                    [0, 0],
                ],
            ],
        };
        const result = parseNominatimBoundaryPayload([
            null,
            { nope: true },
            { osm_id: 7, osm_type: "relation", geojson: good },
            { osm_id: 8, osm_type: "node" }, // no geom
        ]);
        expect(result!.features).toHaveLength(1);
        expect(result!.features[0].properties.osm_id).toBe(7);
    });
});
