import type { BusStopWithLines } from "@/maps/api/overpass";
import type { StationPlace } from "@/maps/api/types";

/**
 * Bus hub hiding rule
 * -------------------
 * A "bus hub" complex qualifies as a hiding zone when:
 *   - its stops pool at least {@link BUS_HUB_MIN_LINES} distinct bus lines,
 *   - it sits more than {@link BUS_HUB_MIN_RAIL_DISTANCE_MILES} from the
 *     nearest rail/metro station (close-in hubs are already covered by the
 *     station's own zone), and
 *   - bus stops within {@link BUS_HUB_CLUSTER_MILES} of each other are
 *     merged into one complex first (a real hub is usually mapped as many
 *     poles, each carrying a few routes).
 *
 * Note: OSM carries no service-frequency data, so the "service at least
 * every 60 minutes" half of the house rule can't be verified here — the
 * complex's full line list is put in the zone name so players can check
 * frequency themselves.
 */
export const BUS_HUB_MIN_LINES = 5;
export const BUS_HUB_CLUSTER_MILES = 0.2;
export const BUS_HUB_MIN_RAIL_DISTANCE_MILES = 0.25;

const MILES_PER_DEGREE_LAT = 69.0;

/** Equirectangular approximation — plenty accurate at sub-mile scales. */
const distanceMiles = (
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
): number => {
    const meanLatRad = ((lat1 + lat2) / 2) * (Math.PI / 180);
    const dLat = (lat2 - lat1) * MILES_PER_DEGREE_LAT;
    const dLon = (lon2 - lon1) * MILES_PER_DEGREE_LAT * Math.cos(meanLatRad);
    return Math.sqrt(dLat * dLat + dLon * dLon);
};

/**
 * Single-linkage clustering of stops at {@link BUS_HUB_CLUSTER_MILES},
 * bucketed on a grid so metro-sized stop sets (NYC has ~15k) stay far from
 * the O(n²) all-pairs comparison.
 */
const clusterStops = (stops: BusStopWithLines[]): BusStopWithLines[][] => {
    const n = stops.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => {
        while (parent[i] !== i) {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        return i;
    };
    const union = (a: number, b: number) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[rb] = ra;
    };

    const cellLat = BUS_HUB_CLUSTER_MILES / MILES_PER_DEGREE_LAT;
    const grid = new Map<string, number[]>();
    const cellOf = (stop: BusStopWithLines) => {
        const lonScale = Math.max(0.2, Math.cos(stop.lat * (Math.PI / 180)));
        return {
            x: Math.floor(stop.lon / (cellLat / lonScale)),
            y: Math.floor(stop.lat / cellLat),
        };
    };
    stops.forEach((stop, i) => {
        const { x, y } = cellOf(stop);
        const key = `${x},${y}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(i);
        else grid.set(key, [i]);
    });

    stops.forEach((stop, i) => {
        const { x, y } = cellOf(stop);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const bucket = grid.get(`${x + dx},${y + dy}`);
                if (!bucket) continue;
                for (const j of bucket) {
                    if (j <= i) continue;
                    const other = stops[j];
                    if (
                        distanceMiles(
                            stop.lat,
                            stop.lon,
                            other.lat,
                            other.lon,
                        ) <= BUS_HUB_CLUSTER_MILES
                    ) {
                        union(i, j);
                    }
                }
            }
        }
    });

    const clusters = new Map<number, BusStopWithLines[]>();
    stops.forEach((stop, i) => {
        const root = find(i);
        const cluster = clusters.get(root);
        if (cluster) cluster.push(stop);
        else clusters.set(root, [stop]);
    });
    return [...clusters.values()];
};

const railStationCoords = (
    railStations: StationPlace[],
): [number, number][] => {
    const coords: [number, number][] = [];
    for (const station of railStations) {
        const geom: any = station.geometry;
        if (geom?.type !== "Point") continue;
        const [lon, lat] = geom.coordinates;
        if (typeof lat === "number" && typeof lon === "number") {
            coords.push([lat, lon]);
        }
    }
    return coords;
};

/**
 * Turn raw bus stops into qualifying bus-hub complexes as
 * {@link StationPlace} features ready to merge into the station list.
 */
export const buildBusHubComplexes = (
    stops: BusStopWithLines[],
    railStations: StationPlace[],
): StationPlace[] => {
    const rail = railStationCoords(railStations);
    const hubs: StationPlace[] = [];

    for (const cluster of clusterStops(stops)) {
        const lines = new Set<string>();
        for (const stop of cluster) {
            for (const line of stop.lines) lines.add(line);
        }
        if (lines.size < BUS_HUB_MIN_LINES) continue;

        const lat = cluster.reduce((sum, s) => sum + s.lat, 0) / cluster.length;
        const lon = cluster.reduce((sum, s) => sum + s.lon, 0) / cluster.length;

        const nearRail = rail.some(
            ([rLat, rLon]) =>
                distanceMiles(lat, lon, rLat, rLon) <=
                BUS_HUB_MIN_RAIL_DISTANCE_MILES,
        );
        if (nearRail) continue;

        const sortedLines = [...lines].sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true }),
        );
        const baseName = cluster.find((s) => s.name)?.name ?? "Unnamed bus hub";
        // Stable id: smallest member node id, so disabling/deduping a hub
        // survives refetches even if the centroid drifts slightly.
        const idNums = cluster
            .map((s) => Number(s.id.split("/")[1]))
            .filter((x) => Number.isFinite(x))
            .sort((a, b) => a - b);
        const id = `bushub/${idNums[0] ?? `${lat},${lon}`}`;

        hubs.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [lon, lat] },
            properties: {
                id,
                name: `${baseName} — Bus Hub (${lines.size} lines: ${sortedLines.join(", ")})`,
            },
        } as StationPlace);
    }

    return hubs;
};
