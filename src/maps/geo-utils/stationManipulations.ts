import * as turf from "@turf/turf";

import type { StationPlace } from "@/maps/api";

/**
 * Function to merge duplicates stations into one station, by averaging their longitude and latitude
 * @param places    Array of all unmerged stations
 * @param radius    Radius of the hiding zone
 * @param units     turf.Units unit of the radius ("miles", "kilometers" etc.)
 * @returns         Array of all merged stations
 */
export function mergeDuplicateStation(
    places: StationPlace[],
    radius: number,
    units: turf.Units,
): StationPlace[] {
    const grouped = new Map<string, any[]>();
    // 1. Group by name
    for (const place of places) {
        const name = place.properties.name ?? "";
        // Check if the group already exist, if not add a new group entry.
        if (!grouped.has(name)) {
            grouped.set(name, [place]);
        } else {
            // group already exist, need to check all groups and all members if their zones are shared
            let placeAdded = false;
            for (const group of grouped) {
                // check all groups
                const groupValues = group[1];

                // if the name matches the first group members name, check all members
                if (groupValues[0].properties.name == name) {
                    let shareZones: boolean = false;
                    for (const groupPlace of groupValues) {
                        const station1: Location = {
                            coordinates: place.geometry.coordinates,
                        };
                        const station2: Location = {
                            coordinates: groupPlace.geometry.coordinates,
                        };
                        shareZones = checkIfStationsShareZones(
                            station1,
                            station2,
                            radius,
                            units,
                        );
                        if (!shareZones) {
                            // new zone does not overlap with a station, leave early
                            break;
                        }
                    }
                    if (shareZones) {
                        // add to group if all stations share the zone
                        groupValues.push(place);
                        placeAdded = true;
                        break; // leave group search, as the new place is already added
                    }
                }
            }

            if (!placeAdded) {
                // if we arrive here, we need to make a new group with a unique key

                // searching for all groups containing the station name to find latest index
                const matches = Array.from(grouped.entries()).filter(
                    ([key]) => typeof key === "string" && key.includes(name),
                );
                const lastGroup = matches.at(-1); // last group has the latest index
                let lastKey = "0";
                if (lastGroup) {
                    lastKey = lastGroup[0];
                }
                const lastIdx = Number(lastKey.split("#")[1] ?? "0");
                const nextIdx = lastIdx + 1;
                const key: string = name + "#" + nextIdx.toString();
                // New key example: "Station Name#1"
                grouped.set(key, [place]);
            }
        }
    }

    // 2. Compute central point per group
    const merged: any[] = [];
    grouped.forEach((group) => {
        const avgLng =
            group.reduce((sum, p) => sum + p.geometry.coordinates[0], 0) /
            group.length;
        const avgLat =
            group.reduce((sum, p) => sum + p.geometry.coordinates[1], 0) /
            group.length;

        merged.push({
            ...group[0], // copy other fields from the first feature
            geometry: {
                type: "Point",
                coordinates: [avgLng, avgLat],
            },
        });
    });
    return merged;
}

// Location object definition
export type Location = {
    name?: string;
    type?: string;
    coordinates: number[]; // [longitude, latitude]
};

/**
 * Check if two stations share a zone in a way that both centers are inside the others radius.
 * Both stations must lie within the given radius of each other.
 *
 * Matches:
 *      (...{Z1..Z2)...}
 * Does not match:
 *      (....Z1....) {....Z2....}
 * @param station1 First station location.
 * @param station2 Second station location.
 * @param radius   The zone radius around each station.
 * @param units    The unit for the radius ("miles","kilometers", "meters").
 * @returns        True if both stations share a zone, otherwise false.
 */
export function checkIfStationsShareZones(
    station1: Location,
    station2: Location,
    radius: number,
    units: turf.Units,
): boolean {
    // Convert to turf points
    const point1 = turf.point([
        station1.coordinates[0],
        station1.coordinates[1],
    ]);
    const point2 = turf.point([
        station2.coordinates[0],
        station2.coordinates[1],
    ]);

    // Distance of the 2 center points
    const d = turf.distance(point1, point2, { units });

    // If the distance of the 2 center points is smaller or equal of the radius, the 2 zones overlap.
    return d <= radius;
}

/** Ferry docks are mapped by many hands under many names. */
const isFerryPlace = (place: StationPlace) => {
    const p = place.properties;
    return (
        p.amenity === "ferry_terminal" ||
        p.platform === "ferry" ||
        p.ferry === "yes"
    );
};

/**
 * Ferry docks within this distance are one dock. Measured in NYC: the same
 * dock mapped twice sits 29 m apart (Soissons Landing / "Governors Island")
 * and 45 m apart (Whitehall's node and building), while genuinely separate
 * terminals are 120 m apart at the closest (Whitehall / Battery Maritime
 * Building).
 */
const FERRY_MERGE_METERS = 100;

/**
 * Collapse ferry places that are the same dock. Unlike
 * {@link mergeDuplicateStation} this ignores names — "Soissons Landing" and
 * "Governors Island" are one landing — and uses a fixed short distance rather
 * than the hiding radius, so it is safe to always run. Non-ferry places pass
 * through untouched.
 *
 * Each cluster keeps the first entry's id and tags (ways before nodes, since
 * a terminal building is the more deliberate mapping) at the averaged
 * position.
 */
export function mergeNearbyFerryDocks(
    places: StationPlace[],
    meters: number = FERRY_MERGE_METERS,
): StationPlace[] {
    const ferries = places.filter(isFerryPlace);
    if (ferries.length < 2) return places;

    // Single-link clustering: a dock joins a cluster if it is within range
    // of any member. Union-find keeps chains (A-B-C at 60 m steps) together.
    const parent = ferries.map((_, i) => i);
    const find = (i: number): number =>
        parent[i] === i ? i : (parent[i] = find(parent[i]));
    for (let i = 0; i < ferries.length; i++) {
        for (let j = i + 1; j < ferries.length; j++) {
            const d = turf.distance(ferries[i], ferries[j], {
                units: "meters",
            });
            if (d <= meters) parent[find(i)] = find(j);
        }
    }

    const clusters = new Map<number, StationPlace[]>();
    ferries.forEach((f, i) => {
        const root = find(i);
        clusters.set(root, [...(clusters.get(root) ?? []), f]);
    });

    const rank = (p: StationPlace) =>
        String(p.properties.id).startsWith("way/") ? 0 : 1;
    const merged = [...clusters.values()].map((group) => {
        if (group.length === 1) return group[0];
        const keep = [...group].sort((a, b) => rank(a) - rank(b))[0];
        const lng =
            group.reduce((s, p) => s + p.geometry.coordinates[0], 0) /
            group.length;
        const lat =
            group.reduce((s, p) => s + p.geometry.coordinates[1], 0) /
            group.length;
        return {
            ...keep,
            geometry: { type: "Point", coordinates: [lng, lat] },
        } as StationPlace;
    });

    return [...places.filter((p) => !isFerryPlace(p)), ...merged];
}
