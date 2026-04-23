import type { APILocations } from "@/maps/schema";

export const OVERPASS_API = "https://overpass-api.de/api/interpreter";
export const OVERPASS_API_FALLBACK =
    "https://overpass.private.coffee/api/interpreter";
export const GEOCODER_API = "https://photon.komoot.io/api/";
// Nominatim returns pre-simplified boundary polygons in ~50-200KB for
// entire countries, versus 2-10MB from Overpass `out geom`. It's what
// powers the OSM website's "view this relation" rendering and handles
// `polygon_geojson=1` for any OSM relation/way/node id. Preferred for
// the game-territory outline because Overpass regularly 504s on cold
// loads for country-level relations.
export const NOMINATIM_API = "https://nominatim.openstreetmap.org";
export const PASTEBIN_API_POST_URL =
    "https://cors-anywhere.com/https://pastebin.com/api/api_post.php";
export const PASTEBIN_API_RAW_URL = "https://pastebin.com/raw/";
export const PASTEBIN_API_RAW_URL_PROXIED =
    "https://cors-anywhere.com/https://pastebin.com/raw/";

export const ICON_COLORS = {
    black: "#3D3D3D",
    blue: "#2A81CB",
    gold: "#FFD326",
    green: "#2AAD27",
    grey: "#7B7B7B",
    orange: "#CB8427",
    red: "#CB2B3E",
    violet: "#9C2BCB",
};

export const LOCATION_FIRST_TAG: {
    [key in APILocations]:
        | "amenity"
        | "tourism"
        | "leisure"
        | "diplomatic"
        | "natural";
} = {
    aquarium: "tourism",
    hospital: "amenity",
    peak: "natural",
    museum: "tourism",
    theme_park: "tourism",
    zoo: "tourism",
    cinema: "amenity",
    library: "amenity",
    golf_course: "leisure",
    consulate: "diplomatic",
    park: "leisure",
};

/**
 * Overpass tag chain for Jet Lag "airport" questions: scheduled-airport-style
 * facilities with an IATA code.
 *
 * - `aeroway=aerodrome` + `iata`: OSM helipads use `aeroway=helipad`, so they
 *   never match this query.
 * - `heliport!=yes` / `aerodrome:type`≠heliport: some downtown heliports are
 *   tagged as aerodromes with IATA; drop those.
 * - `aerodrome:type`≠balloonport: balloon bases are not airline airports.
 *
 * Grass / private strips are rarely IATA-tagged; if one slips through, it is
 * usually mapper error — we intentionally do not exclude `aerodrome:type=private`
 * because many public-use fields use that value.
 */
export function overpassAirportIataFilter(options?: {
    /** When true, drop `disused` / `closed` facilities (matches "Active airports only"). */
    activeOnly?: boolean;
}): string {
    const activeOnly = options?.activeOnly === true;
    const active = activeOnly ? '["disused"!="yes"]["closed"!="yes"]' : "";
    return (
        '["aeroway"="aerodrome"]["iata"]' +
        '["heliport"!="yes"]' +
        '["aerodrome:type"!="heliport"]' +
        '["aerodrome:type"!="balloonport"]' +
        active
    );
}

/**
 * Appended to each hiding-zone place selector (`[railway=station]`, …) when
 * "Active stations only" is on. Excludes out-of-service / non-passenger
 * facilities using common OSM lifecycle and status tags — including
 * `disused:railway=*` and `operational_status=suspended`, which plain
 * `disused!=yes` misses.
 */
/**
 * Overpass filter for Jet Lag "major city" (1M+ population). Regex is faster
 * than filtering on `population` in a subexpression after fetch.
 */
export const OVERPASS_MAJOR_CITY_FILTER =
    '[place=city]["population"~"^[1-9]+[0-9]{6}$"]';

export const OVERPASS_ACTIVE_RAIL_STATION_EXCLUSIONS =
    '["disused"!="yes"]["abandoned"!="yes"]' +
    '["railway:status"!="abandoned"]["railway:status"!="disused"]["railway:status"!="closed"]' +
    '["operational_status"!="closed"]["operational_status"!="suspended"]' +
    '["operational_status"!="disused"]["operational_status"!="abandoned"]' +
    '["passenger"!="no"]' +
    '["station"!="freight"]["railway:traffic_mode"!="freight"]' +
    '["historic"!="station"]' +
    '["disused:railway"!="station"]["disused:railway"!="halt"]["disused:railway"!="stop"]' +
    '["abandoned:railway"!="station"]["abandoned:railway"!="halt"]["abandoned:railway"!="stop"]';

export const BLANK_GEOJSON = {
    type: "FeatureCollection",
    features: [
        {
            type: "Feature",
            properties: {},
            geometry: {
                type: "Polygon",
                coordinates: [
                    [
                        [-180, -90],
                        [180, -90],
                        [180, 90],
                        [-180, 90],
                        [-180, -90],
                    ],
                ],
            },
        },
    ],
};
