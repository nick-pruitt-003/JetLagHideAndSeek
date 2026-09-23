import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Point } from "geojson";
import { around } from "geokdbush";
import KDBush from "kdbush";

/**
 * Build a reusable "nearest point" lookup over a point collection.
 *
 * `turf.nearestPoint` measures the distance to every point on every call, so
 * asking it once per station is stations × points haversines — the hiding
 * zone filters do exactly that for airports and McDonald's / 7-Eleven. This
 * indexes the points once (a k-d tree searched by great-circle distance), so
 * each lookup only visits the few points near the query.
 *
 * Returns the original feature, like `turf.nearestPoint` minus the
 * `featureIndex` / `distanceToPoint` properties it adds, which no caller of
 * this reads.
 */
export function nearestPointFinder<P>(
    points: FeatureCollection<Point, P>,
): (point: Feature<Point> | number[]) => Feature<Point, P> {
    const features = points.features.filter(
        (f) => f.geometry?.type === "Point",
    );
    if (features.length === 0) {
        // Keep turf's behaviour for the degenerate case rather than invent one.
        return (point) =>
            turf.nearestPoint(
                point as Feature<Point>,
                points as FeatureCollection<Point>,
            ) as unknown as Feature<Point, P>;
    }

    const index = new KDBush(features.length);
    for (const f of features) {
        index.add(f.geometry.coordinates[0], f.geometry.coordinates[1]);
    }
    index.finish();

    return (point) => {
        const [lng, lat] = turf.getCoord(point as Feature<Point>);
        const [nearest] = around(index, lng, lat, 1);
        return features[nearest];
    };
}
