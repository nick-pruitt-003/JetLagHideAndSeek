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
