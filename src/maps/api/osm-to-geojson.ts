import osm2geojson from "osm2geojson-ultra";

import type {
    Feature,
    FeatureCollection,
    GeoJsonProperties,
    Geometry,
    GeometryCollection,
    MultiPolygon,
    Polygon,
} from "geojson";

function polygonizeGeometryCollection(
    geom: GeometryCollection,
): Polygon | MultiPolygon | null {
    const polys: number[][][][] = [];
    for (const g of geom.geometries ?? []) {
        if (g.type === "Polygon") {
            polys.push(g.coordinates);
        } else if (g.type === "MultiPolygon") {
            polys.push(...g.coordinates);
        }
    }
    if (polys.length === 0) return null;
    if (polys.length === 1) {
        return { type: "Polygon", coordinates: polys[0] };
    }
    return { type: "MultiPolygon", coordinates: polys };
}

/**
 * Local compatibility adapter for osm2geojson-ultra relation output.
 *
 * Upstream issue #18 reports admin boundaries frequently emitted as
 * `GeometryCollection`; prefer polygonal members so downstream boundary
 * rendering can operate on Polygon/MultiPolygon directly.
 *
 * Reference: https://github.com/dschep/osm2geojson-ultra/issues/18
 */
export default function osmToGeoJson(input: unknown): FeatureCollection {
    const raw = osm2geojson(input as any);
    const fc: FeatureCollection =
        raw && (raw as { type?: string }).type === "FeatureCollection"
            ? (raw as FeatureCollection)
            : {
                  type: "FeatureCollection",
                  features: raw ? [raw as Feature] : [],
              };

    const features = fc.features.map((f) => {
        if (!f || !f.geometry || f.geometry.type !== "GeometryCollection") {
            return f;
        }
        const poly = polygonizeGeometryCollection(
            f.geometry as GeometryCollection,
        );
        if (!poly) return f;
        return {
            ...f,
            geometry: poly as Geometry,
            properties: (f.properties ?? {}) as GeoJsonProperties,
        } as Feature;
    });

    return { type: "FeatureCollection", features };
}
