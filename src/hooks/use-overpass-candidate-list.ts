import * as React from "react";

/**
 * Shared fetch lifecycle for Overpass-backed candidate lists (airports, OSM
 * facilities): cancel on unmount, log failures, clear when disabled.
 */
export function useOverpassCandidateList<T>(
    enabled: boolean,
    load: () => Promise<T[]>,
    refreshToken?: unknown,
): { items: T[]; loading: boolean } {
    type State = { items: T[]; loading: boolean };
    type Action =
        | { type: "loading" }
        | { type: "loaded"; items: T[] }
        | { type: "failed" };
    const [state, dispatch] = React.useReducer(
        (prev: State, action: Action): State => {
            if (!action || typeof action !== "object" || !("type" in action)) {
                return prev;
            }
            switch (action.type) {
                case "loading":
                    return { ...prev, loading: true };
                case "loaded":
                    return { items: action.items, loading: false };
                case "failed":
                    return { items: [], loading: false };
            }
        },
        { items: [], loading: false },
    );

    React.useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        dispatch({ type: "loading" });
        load()
            .then((data) => {
                if (!cancelled) dispatch({ type: "loaded", items: data });
            })
            .catch((err) => {
                console.error("useOverpassCandidateList: load failed", err);
                if (!cancelled) dispatch({ type: "failed" });
            });
        return () => {
            cancelled = true;
        };
    }, [enabled, load, refreshToken]);

    return enabled ? state : { items: [], loading: false };
}
