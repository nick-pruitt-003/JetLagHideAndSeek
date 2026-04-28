import {
    getAllRoutes,
    getAllStops,
    getAllStopTimes,
    getAllTrips,
    listSystems,
} from "./gtfs-store";

const lineMembershipCache = new Map<string, Promise<Set<string>>>();

const normalizeLineRef = (value: string) =>
    value
        .trim()
        .replace(/^<+/, "")
        .replace(/>+$/, "")
        .toUpperCase();

const normalizeStationName = (value: string) =>
    value
        .toUpperCase()
        .normalize("NFKD")
        .replace(/[^\w\s]|_/g, " ")
        .replace(/\s+/g, " ")
        .trim();

const lineRefMatchesRoute = (normalizedRef: string, routeRefRaw?: string) => {
    const routeRef = normalizeLineRef(routeRefRaw ?? "");
    if (!routeRef) return false;
    if (routeRef === normalizedRef) return true;
    const tokens = routeRef
        .split(/[;,/ ]+/)
        .map((x) => normalizeLineRef(x))
        .filter(Boolean);
    return tokens.includes(normalizedRef);
};

export async function getGtfsStationNamesForLineRef(
    lineRefRaw: string,
): Promise<Set<string>> {
    const normalizedRef = normalizeLineRef(lineRefRaw);
    if (!normalizedRef) return new Set();

    const existing = lineMembershipCache.get(normalizedRef);
    if (existing) return existing;

    const pending = (async () => {
        const systems = await listSystems();
        const systemIds = systems
            .filter((s) => {
                const id = s.id.toLowerCase();
                const name = s.name.toLowerCase();
                return id.includes("subway") || name.includes("subway");
            })
            .map((s) => s.id);

        const [routes, trips, stopTimes, stops] = await Promise.all([
            getAllRoutes(systemIds.length > 0 ? systemIds : undefined),
            getAllTrips(systemIds.length > 0 ? systemIds : undefined),
            getAllStopTimes(systemIds.length > 0 ? systemIds : undefined),
            getAllStops(systemIds.length > 0 ? systemIds : undefined),
        ]);

        const routeIds = new Set(
            routes
                .filter(
                    (route) =>
                        route.routeType === 1 &&
                        lineRefMatchesRoute(normalizedRef, route.shortName),
                )
                .map((route) => route.id),
        );
        if (routeIds.size === 0) return new Set<string>();

        const tripIds = new Set(
            trips
                .filter((trip) => routeIds.has(trip.routeId))
                .map((trip) => trip.id),
        );
        if (tripIds.size === 0) return new Set<string>();

        const stopIds = new Set<string>();
        for (const tripStopTime of stopTimes) {
            if (!tripIds.has(tripStopTime.tripId)) continue;
            for (const stopId of tripStopTime.stopIds) stopIds.add(stopId);
        }
        if (stopIds.size === 0) return new Set<string>();

        const stopById = new Map(stops.map((stop) => [stop.id, stop]));
        const stationNames = new Set<string>();
        for (const stopId of stopIds) {
            const stop = stopById.get(stopId);
            if (!stop) continue;
            const n = normalizeStationName(stop.name);
            if (n) stationNames.add(n);
            if (stop.parentStopId) {
                const parent = stopById.get(stop.parentStopId);
                if (parent) {
                    const pn = normalizeStationName(parent.name);
                    if (pn) stationNames.add(pn);
                }
            }
        }

        return stationNames;
    })();

    lineMembershipCache.set(normalizedRef, pending);
    return pending;
}
