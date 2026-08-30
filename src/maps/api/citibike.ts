import { cacheFetch } from "@/maps/api/cache";
import { CacheType } from "@/maps/api/types";

/**
 * Citi Bike GBFS station information (static station list: names,
 * coordinates, dock capacity). This is the slow-moving feed — live bike
 * availability lives in station_status, which we deliberately do NOT use
 * because cacheFetch entries have no TTL and stale dock counts are worse
 * than no dock counts.
 */
// Always routed through /api/proxy-api — even in dev, where other feeds go
// direct — because the GBFS host serves no CORS headers, so browser-direct
// fetches always fail. The host is on the proxy allowlist and in
// PROXY_ONLY_HOSTS, and astro dev serves the proxy route too.
const CITIBIKE_STATION_INFORMATION_URL = `/api/proxy-api?url=${encodeURIComponent(
    "https://gbfs.citibikenyc.com/gbfs/en/station_information.json",
)}`;

export interface CitiBikeStation {
    id: string;
    name: string;
    lat: number;
    lon: number;
    capacity?: number;
}

export const fetchCitiBikeStations = async (): Promise<CitiBikeStation[]> => {
    const response = await cacheFetch(
        CITIBIKE_STATION_INFORMATION_URL,
        "Loading Citi Bike stations...",
        CacheType.ZONE_CACHE,
    );
    const data = await response.json();
    const rawStations: any[] = data?.data?.stations ?? [];

    return rawStations
        .filter(
            (s) =>
                typeof s?.lat === "number" &&
                typeof s?.lon === "number" &&
                s.lat !== 0 &&
                s.lon !== 0,
        )
        .map((s) => ({
            id: String(s.station_id ?? `${s.lat},${s.lon}`),
            name: String(s.name ?? "Citi Bike station"),
            lat: s.lat,
            lon: s.lon,
            capacity: typeof s.capacity === "number" ? s.capacity : undefined,
        }));
};
