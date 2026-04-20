import * as turf from "@turf/turf";
import { geoMercator } from "d3-geo";
// @ts-expect-error No type declaration
import { geoProject, geoStitch } from "d3-geo-projection";
// @ts-expect-error No type declaration
import { geoVoronoi } from "d3-geo-voronoi";
import type { FeatureCollection, MultiPolygon, Point, Polygon } from "geojson";

const scaleReference = turf.toMercator(turf.point([180, 90])); // I thought this would yield the same as turf.earthRadius * Math.pi, but it's slightly larger

export const geoSpatialVoronoi = (
    points: FeatureCollection<Point>,
): FeatureCollection<Polygon | MultiPolygon> => {
    const voronoi = geoVoronoi()(points).polygons();
    const projected = geoProject(
        geoStitch(voronoi),
        geoMercator().translate([0, 0]).precision(0.005),
    );

    const ratio = scaleReference.geometry.coordinates[0] / 480.5; // 961 is the default scale for some reason

    turf.coordEach(projected, (coord) => {
        coord[0] = coord[0] * ratio;
        coord[1] = coord[1] * -ratio; // y-coordinates are flipped
    });

    const result = turf.toWgs84(projected);

    // geoStitch can reorder features when stitching antimeridian-spanning
    // polygons. Restore the original input order using the `.site` property
    // that d3-geo-voronoi attaches to each polygon (pointing to the input
    // feature that "owns" that cell). Properties are not touched by
    // geoProject/coordEach so site.geometry.coordinates are still WGS84.
    result.features.sort((a: any, b: any) => {
        const coordsA: [number, number] | undefined =
            a.properties?.site?.geometry?.coordinates;
        const coordsB: [number, number] | undefined =
            b.properties?.site?.geometry?.coordinates;
        const indexOf = (coords: [number, number] | undefined) =>
            coords == null
                ? -1
                : points.features.findIndex(
                      (p) =>
                          p.geometry.coordinates[0] === coords[0] &&
                          p.geometry.coordinates[1] === coords[1],
                  );
        return indexOf(coordsA) - indexOf(coordsB);
    });

    return result;
};
