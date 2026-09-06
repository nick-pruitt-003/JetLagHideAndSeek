/**
 * Grouping helpers for the live hiding-station gauge.
 *
 * Kept out of the component so the tag handling — which is the part with real
 * edge cases (semicolon-joined networks, missing operators, non-rail stations)
 * — can be unit tested without rendering anything.
 */

/** A hiding-zone circle carries its station Point feature as `properties`. */
export interface StationLike {
    properties?: {
        properties?: Record<string, string | undefined>;
    };
}

/** OSM tags live on the inner station Point feature, not the circle. */
const stationTags = (station: StationLike) =>
    station.properties?.properties ?? {};

/**
 * Label a station by the network a player would recognise, preferring the
 * `network` tag over `operator` (the former is "MTA New York City Subway",
 * the latter often the parent agency shared across modes).
 */
export const stationOperatorLabel = (station: StationLike): string => {
    const tags = stationTags(station);
    const raw =
        tags.network ||
        tags.operator ||
        (tags.station === "subway" || tags.subway === "yes"
            ? "Subway"
            : undefined) ||
        "Other";

    // Interchanges carry every serving network, semicolon-joined:
    // "MTA New York City Transit;MTA Long Island Rail Road". Attribute the
    // station to the first so each one is counted exactly once.
    return raw.split(";")[0].trim() || "Other";
};

/**
 * Count stations per network label, largest group first.
 *
 * Ties keep the order the labels were first seen: string keys iterate in
 * insertion order and `Array.prototype.sort` is stable, so the same input
 * always yields the same order.
 */
export const countByOperator = (
    stations: StationLike[],
): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const station of stations) {
        const key = stationOperatorLabel(station);
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.fromEntries(
        Object.entries(counts).sort(([, left], [, right]) => right - left),
    );
};
