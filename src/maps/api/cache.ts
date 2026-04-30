import _ from "lodash";
import { toast } from "react-toastify";

import { CacheType } from "@/maps/api/types";

const determineQuestionCache = _.memoize(() => caches.open(CacheType.CACHE));
const determineZoneCache = _.memoize(() => caches.open(CacheType.ZONE_CACHE));
const determinePermanentCache = _.memoize(() =>
    caches.open(CacheType.PERMANENT_CACHE),
);

const inFlightFetches = new Map<string, Promise<Response>>();

function reportFetchFailure(args: {
    url: string;
    cacheType: CacheType;
    loadingText?: string;
    status?: number;
    statusText?: string;
    error?: unknown;
}) {
    const payload = {
        url: args.url,
        cacheType: args.cacheType,
        loadingText: args.loadingText,
        status: args.status ?? 599,
        statusText: args.statusText ?? "Network Error",
        error:
            args.error instanceof Error
                ? args.error.message
                : args.error != null
                  ? String(args.error)
                  : undefined,
        timestamp: new Date().toISOString(),
    };
    if (typeof window !== "undefined") {
        const w = window as Window & { __jlFetchFailures?: unknown[] };
        w.__jlFetchFailures = w.__jlFetchFailures ?? [];
        w.__jlFetchFailures.push(payload);
    }
    console.error("[cacheFetch] request failed", payload);
}

export const determineCache = async (cacheType: CacheType) => {
    switch (cacheType) {
        case CacheType.CACHE:
            return await determineQuestionCache();
        case CacheType.ZONE_CACHE:
            return await determineZoneCache();
        case CacheType.PERMANENT_CACHE:
            return await determinePermanentCache();
    }
};

export const cacheFetch = async (
    url: string,
    loadingText?: string,
    cacheType: CacheType = CacheType.CACHE,
) => {
    try {
        const cache = await determineCache(cacheType);

        const cachedResponse = await cache.match(url);
        if (cachedResponse) {
            if (!cachedResponse.ok) {
                await cache.delete(url);
            } else {
                return cachedResponse.clone();
            }
        }

        const inflightKey = `${cacheType}:${url}`;
        const existingFetch = inFlightFetches.get(inflightKey);
        if (existingFetch) {
            const response = await existingFetch;
            return response.clone();
        }

        const fetchAndMaybeCache = async () => {
            let response: Response;
            try {
                response = await fetch(url);
            } catch (error) {
                reportFetchFailure({
                    url,
                    cacheType,
                    loadingText,
                    error,
                });
                response = new Response("", {
                    status: 599,
                    statusText: "Network Error",
                });
            }
            if (response.ok) {
                await cache.put(url, response.clone());
            } else {
                reportFetchFailure({
                    url,
                    cacheType,
                    loadingText,
                    status: response.status,
                    statusText: response.statusText,
                });
                await cache.delete(url);
            }
            return response;
        };

        const fetchPromise = fetchAndMaybeCache();
        inFlightFetches.set(inflightKey, fetchPromise);

        try {
            const response = await (loadingText
                ? toast.promise(fetchPromise, {
                      pending: loadingText,
                  })
                : fetchPromise);

            return response.clone();
        } finally {
            inFlightFetches.delete(inflightKey);
        }
    } catch (e) {
        console.log(e); // Probably a caches not supported error
        try {
            const response = await fetch(url);
            if (!response.ok) {
                reportFetchFailure({
                    url,
                    cacheType,
                    loadingText,
                    status: response.status,
                    statusText: response.statusText,
                });
            }
            return response;
        } catch (error) {
            reportFetchFailure({
                url,
                cacheType,
                loadingText,
                error,
            });
            return new Response("", {
                status: 599,
                statusText: "Network Error",
            });
        }
    }
};

export const clearCache = async (cacheType: CacheType = CacheType.CACHE) => {
    try {
        const cache = await determineCache(cacheType);
        await cache.keys().then((keys) => {
            keys.forEach((key) => {
                cache.delete(key);
            });
        });
    } catch (e) {
        console.log(e); // Probably a caches not supported error
    }
};
