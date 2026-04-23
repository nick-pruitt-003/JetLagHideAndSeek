import * as React from "react";

/**
 * Shared fetch lifecycle for Overpass-backed candidate lists (airports, OSM
 * facilities): cancel on unmount, log failures, clear when disabled.
 */
export function useOverpassCandidateList<T>(
    enabled: boolean,
    load: () => Promise<T[]>,
    deps: React.DependencyList,
): { items: T[]; loading: boolean } {
    const [items, setItems] = React.useState<T[]>([]);
    const [loading, setLoading] = React.useState(false);

    React.useEffect(() => {
        if (!enabled) {
            setItems([]);
            return;
        }
        let cancelled = false;
        setLoading(true);
        load()
            .then((data) => {
                if (!cancelled) setItems(data);
            })
            .catch((err) => {
                console.error("useOverpassCandidateList: load failed", err);
                if (!cancelled) setItems([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [enabled, ...deps]);

    return { items, loading };
}
