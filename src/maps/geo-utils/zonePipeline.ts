/**
 * Pure helpers for the hiding-zone / station pipeline in ZoneSidebar.
 *
 * Extracted from the single monolithic `initializeHidingZones` effect so
 * we can:
 *   1. Split fetch-and-build-circles (Phase A) from the cheap
 *      question-driven filter pass (Phase B). Phase A is expensive but
 *      rarely invalidated; Phase B runs on every question edit but is
 *      now fully client-side.
 *   2. Unit-test the filter logic with synthetic circles outside React.
 *   3. Bbox-prefilter circles against the playable region before the
 *      expensive `turf.booleanWithin` call, which is the single hottest
 *      inner operation for big metros like NYC.
 *
 * None of these functions read nanostores. Pass everything in.
 */

import * as turf from "@turf/turf";
import type {
    BBox,
    Feature,
    FeatureCollection,
    MultiPolygon,
    Point,
    Polygon,
} from "geojson";
import type { toast as toastFn } from "react-toastify";

import {
    lookupArrivalWithParentFallback,
    type MatchedStation,
} from "@/lib/transit/osm-gtfs-match";
import type { TransitStop } from "@/lib/transit/types";
import {
    findPlacesSpecificInZone,
    QuestionSpecificLocation,
    type StationCircle,
    type StationPlace,
    trainLineNodeFinder,
} from "@/maps/api";
import { extractStationName } from "@/maps/geo-utils/special";
import { geoSpatialVoronoi } from "@/maps/geo-utils/voronoi";
import { findMatchingPlaces } from "@/maps/questions/matching";
import type {
    MatchingQuestion,
    MatchingQuestionWithFacilityOsmRefs,
    Question,
} from "@/maps/schema";

// ---------------------------------------------------------------------------
// Phase A: build the raw circle set (no question filtering)
// ---------------------------------------------------------------------------

export interface BuildCirclesOptions {
    radius: number;
    units: turf.Units;
    /** Passed through into circle.properties so downstream callers can
     *  recover the OSM id/name. */
    steps?: number;
}

/**
 * Turn a list of station points into turf circles of the given radius.
 * Pure; no store access, no async. Safe to memoize on
 * (places-signature, radius, units).
 */
export function buildCirclesFromPlaces(
    places: StationPlace[],
    { radius, units, steps = 32 }: BuildCirclesOptions,
): StationCircle[] {
    const out: StationCircle[] = [];
    for (const place of places) {
        const center = turf.getCoord(place);
        const circle = turf.circle(center, radius, {
            steps,
            units,
            properties: place,
        });
        out.push(circle);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Phase B: geometric cull against the playable region
// ---------------------------------------------------------------------------

/**
 * `questionFinishedMapData` is a HOLED MASK: one or more polygons whose
 * outer ring covers the whole world and whose inner rings (holes) are
 * the remaining playable regions. `turf.bbox` on such a polygon
 * collapses to the world bbox, which is useless for spatial
 * prefiltering.
 *
 * This helper walks the inner rings of every polygon and returns the
 * bbox spanning the playable holes. Returns null if no holes are
 * present (i.e. the mask has eliminated everything; nothing to keep).
 */
export function playableBboxFromHoledMask(
    data: FeatureCollection | Feature | null | undefined,
): BBox | null {
    if (!data) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let hadAnyHole = false;

    const pushRing = (ring: number[][]) => {
        for (const c of ring) {
            const lng = c[0];
            const lat = c[1];
            if (lng < minX) minX = lng;
            if (lng > maxX) maxX = lng;
            if (lat < minY) minY = lat;
            if (lat > maxY) maxY = lat;
        }
        hadAnyHole = true;
    };

    const visit = (feature: Feature) => {
        const geom = feature.geometry;
        if (!geom) return;
        if (geom.type === "Polygon") {
            // Inner rings (index 1+) are holes.
            for (let i = 1; i < geom.coordinates.length; i++) {
                pushRing(geom.coordinates[i]);
            }
        } else if (geom.type === "MultiPolygon") {
            for (const poly of geom.coordinates) {
                for (let i = 1; i < poly.length; i++) {
                    pushRing(poly[i]);
                }
            }
        }
    };

    if ("type" in data && data.type === "FeatureCollection") {
        for (const f of data.features) visit(f);
    } else if ("type" in data && data.type === "Feature") {
        visit(data);
    }

    if (!hadAnyHole) return null;
    return [minX, minY, maxX, maxY];
}

/**
 * Approximate bbox of a point-centered circle, cheap to compute. Good
 * enough for a bbox-disjoint prefilter; the real `turf.booleanWithin`
 * handles the exact containment check afterwards.
 */
function cheapCircleBbox(lng: number, lat: number, radiusKm: number): BBox {
    const dLat = radiusKm / 111.32;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const dLng = radiusKm / (111.32 * Math.max(cosLat, 1e-6));
    return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

/** True iff the two bboxes do not overlap at all. */
function bboxesDisjoint(a: BBox, b: BBox): boolean {
    return a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3];
}

export interface CullOptions {
    /** Bbox of the playable region, as returned by
     *  {@link playableBboxFromHoledMask}. If present, circles whose
     *  bbox is disjoint from this are dropped before the expensive
     *  `booleanWithin` test. */
    playableBbox: BBox | null;
    /** The holed-mask polygon that `booleanWithin` is checked against.
     *  Pre-unionized and simplified by the caller. */
    unionizedMask: Feature;
    /** Hiding radius converted to kilometers, used for cheap circle
     *  bbox construction. Passing it in avoids re-deriving it per
     *  circle. */
    radiusKm: number;
}

/**
 * Keep only circles that have *some* part inside the playable region.
 *
 * The existing logic was `!turf.booleanWithin(circle, holedMask)` — a
 * circle is inside the holed mask iff every point of the circle is in
 * the world-minus-playable area, which means the circle has no overlap
 * with any playable region. So `!booleanWithin` keeps circles that
 * overlap at least partially with a playable region.
 *
 * We short-circuit with a bbox disjoint check against the bbox of the
 * playable region (the holes). A circle whose bbox doesn't touch the
 * playable bbox definitely lies entirely in the mask and is dropped
 * without invoking booleanWithin.
 */
export function cullCirclesAgainstZone(
    circles: StationCircle[],
    { playableBbox, unionizedMask, radiusKm }: CullOptions,
): StationCircle[] {
    const out: StationCircle[] = [];
    for (const circle of circles) {
        // Cheap prefilter: if there's no playable region at all, keep
        // nothing. (Defensive — typically playableBbox is non-null.)
        if (!playableBbox) continue;

        const center = turf.getCoord(circle.properties);
        const cBbox = cheapCircleBbox(center[0], center[1], radiusKm);
        if (bboxesDisjoint(cBbox, playableBbox)) continue;

        if (!turf.booleanWithin(circle, unionizedMask)) {
            out.push(circle);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Phase B: question-driven filters
// ---------------------------------------------------------------------------

export type ToastFn = typeof toastFn;

function normalizedDisabledFacilityRefsForCache(
    data: MatchingQuestion,
): string[] {
    const refs = (data as MatchingQuestionWithFacilityOsmRefs)
        .disabledFacilityOsmRefs;
    return [...(refs ?? [])]
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .sort();
}

/**
 * Stable cache key for Voronoi-style matching. Zone-scoped types share one
 * Overpass result per territory + flags (seeker lat/lng does not affect
 * {@link findMatchingPlaces} for airport / major-city / *-full).
 */
export function matchingFacilityCacheKey(
    data: MatchingQuestion,
    zoneKey: string,
): string {
    if (data.type === "airport") {
        return JSON.stringify({
            type: data.type,
            zone: zoneKey,
            activeOnly: data.activeOnly === true,
            disabledAirports: [...(data.disabledAirportIatas ?? [])]
                .map((s) => s.trim().toUpperCase())
                .filter(Boolean)
                .sort(),
        });
    }
    if (data.type === "major-city") {
        return JSON.stringify({
            type: data.type,
            zone: zoneKey,
            disabledFacilities: normalizedDisabledFacilityRefsForCache(data),
        });
    }
    if (typeof data.type === "string" && data.type.endsWith("-full")) {
        return JSON.stringify({
            type: data.type,
            zone: zoneKey,
            disabledFacilities: normalizedDisabledFacilityRefsForCache(data),
        });
    }
    if (data.type === "custom-points") {
        return JSON.stringify({
            type: data.type,
            lat: data.lat,
            lng: data.lng,
            geo: data.geo,
        });
    }
    return JSON.stringify({
        type: data.type,
        zone: zoneKey,
    });
}

function isVoronoiMatchingType(data: Question["data"]): boolean {
    if (!data || typeof data !== "object" || !("type" in data)) return false;
    const t = (data as { type: string }).type;
    if (t === "airport" || t === "major-city" || t === "custom-points")
        return true;
    return typeof t === "string" && t.endsWith("-full");
}

function normalizeMatchingPointsToFc(
    raw:
        | FeatureCollection<Point>
        | Feature<Point>
        | Feature<Point>[]
        | null
        | undefined,
): FeatureCollection<Point> {
    if (!raw) return turf.featureCollection([]);
    if (Array.isArray(raw)) return turf.featureCollection(raw);
    if (raw.type === "FeatureCollection")
        return raw as FeatureCollection<Point>;
    if (raw.type === "Feature") {
        return turf.featureCollection([raw as Feature<Point>]);
    }
    return turf.featureCollection([]);
}

/**
 * Pre-fetch facility point sets used by Voronoi matching questions so
 * {@link applyQuestionFilters} can classify each hiding circle by nearest
 * site (same logic as {@link findMatchingPlaces} / map Voronoi).
 */
export async function prefetchMatchingFacilityPoints(
    questions: Question[],
    zoneKey: string,
): Promise<Map<string, FeatureCollection<Point>>> {
    const unique = new Map<string, MatchingQuestion>();
    for (const q of questions) {
        if (q.id !== "matching") continue;
        if (!isVoronoiMatchingType(q.data)) continue;
        const key = matchingFacilityCacheKey(
            q.data as MatchingQuestion,
            zoneKey,
        );
        if (!unique.has(key)) unique.set(key, q.data as MatchingQuestion);
    }
    if (unique.size === 0) return new Map();

    const entries = await Promise.all(
        [...unique.entries()].map(async ([key, mq]) => {
            const raw = await findMatchingPlaces(mq);
            return [key, normalizeMatchingPointsToFc(raw)] as const;
        }),
    );
    return new Map(entries);
}

export interface ApplyQuestionFiltersOptions {
    circles: StationCircle[];
    questions: Question[];
    /** Pre-fetched POI feature collections keyed by
     *  `QuestionSpecificLocation` tag string. Populated by
     *  {@link prefetchMeasuringPoiPoints} so we don't serialize one
     *  Overpass fetch per measuring question. */
    measuringPoiCache: Map<string, FeatureCollection<any>>;
    /** Pre-fetched points for Voronoi-style matching; keyed by
     *  {@link matchingFacilityCacheKey} with this zone suffix. */
    matchingFacilityCache?: Map<string, FeatureCollection<Point>>;
    /** Territory key aligned with {@link prefetchMatchingFacilityPoints}. */
    matchingZoneKey: string;
    hidingRadius: number;
    useCustomStations: boolean;
    includeDefaultStations: boolean;
    /** When true, draggable-in-planning-mode questions are skipped. */
    planningModeEnabled: boolean;
    /** Optional toast hook for user-visible warnings. No-ops if absent
     *  (e.g. in tests). */
    toast?: ToastFn;
    /** Hook used to resolve OSM train-line nodes. Swappable for tests. */
    resolveTrainLineNodes?: (osmIdPath: string) => Promise<number[]>;
}

/**
 * Apply every active matching/measuring filter to the circle set. Pure
 * in its inputs — the only async work is `resolveTrainLineNodes`,
 * which defaults to `trainLineNodeFinder`.
 */
export async function applyQuestionFilters({
    circles,
    questions,
    measuringPoiCache,
    matchingFacilityCache = new Map(),
    matchingZoneKey,
    hidingRadius,
    useCustomStations,
    includeDefaultStations,
    planningModeEnabled,
    toast,
    resolveTrainLineNodes = trainLineNodeFinder,
}: ApplyQuestionFiltersOptions): Promise<StationCircle[]> {
    let current = circles;

    for (const question of questions) {
        if (planningModeEnabled && question.data.drag) continue;

        if (
            question.id === "matching" &&
            isVoronoiMatchingType(question.data)
        ) {
            if (current.length === 0) break;

            const key = matchingFacilityCacheKey(
                question.data as MatchingQuestion,
                matchingZoneKey,
            );
            const points = matchingFacilityCache.get(key);
            if (!points || points.features.length === 0) continue;

            const seekerPoint = turf.point([
                question.data.lng,
                question.data.lat,
            ]);
            const voronoiFc = geoSpatialVoronoi(
                points as FeatureCollection<Point>,
            );
            const [sx, sy] = seekerPoint.geometry.coordinates;
            const coordEq = (a: number, b: number) => Math.abs(a - b) < 1e-9;
            let seekerCell = voronoiFc.features.find((cell) => {
                const c = (
                    cell.properties as
                        | { site?: Feature<Point> }
                        | null
                        | undefined
                )?.site?.geometry?.coordinates as [number, number] | undefined;
                if (!c) return false;
                return coordEq(c[0], sx) && coordEq(c[1], sy);
            });
            if (!seekerCell?.geometry) {
                seekerCell = voronoiFc.features.find(
                    (cell) =>
                        Boolean(cell.geometry) &&
                        turf.booleanPointInPolygon(
                            seekerPoint,
                            cell as Feature<Polygon | MultiPolygon>,
                        ),
                );
            }
            if (!seekerCell?.geometry) continue;

            const wantSame = question.data.same === true;
            current = current.filter((circle) => {
                const zone = circle as Feature<Polygon | MultiPolygon>;
                const seekerRegion = seekerCell as Feature<Polygon | MultiPolygon>;

                // A hiding zone is valid if there exists at least one point
                // within the zone that can satisfy the matching constraint.
                // Center-only checks over-prune large zones that cross the
                // Voronoi boundary between facilities.
                const intersectsSeekerRegion = !turf.booleanDisjoint(
                    zone,
                    seekerRegion,
                );

                if (wantSame) {
                    return intersectsSeekerRegion;
                }

                // For "different", only zones entirely contained in the
                // seeker's Voronoi cell are impossible.
                return !turf.booleanWithin(zone, seekerRegion);
            });
        }

        if (
            question.id === "matching" &&
            (question.data.type === "same-first-letter-station" ||
                question.data.type === "same-length-station" ||
                question.data.type === "same-train-line")
        ) {
            if (current.length === 0) break;

            const location = turf.point([question.data.lng, question.data.lat]);

            const nearestTrainStation = turf.nearestPoint(
                location,
                turf.featureCollection(current.map((x) => x.properties)) as any,
            );

            if (question.data.type === "same-train-line") {
                if (useCustomStations && !includeDefaultStations) {
                    toast?.warning(
                        "'Same train line' isn't supported with custom-only station lists; skipping this filter.",
                    );
                } else {
                    const nid = nearestTrainStation.properties.id as
                        | string
                        | undefined;
                    if (!nid || !nid.includes("/")) {
                        toast?.warning(
                            "Nearest station has no OSM id; skipping 'same train line' filter.",
                        );
                        continue;
                    }

                    const nodes = await resolveTrainLineNodes(nid);
                    if (nodes.length === 0) {
                        toast?.warning(
                            `No train line found for ${extractStationName(
                                nearestTrainStation,
                            )}`,
                        );
                        continue;
                    }
                    current = current.filter((circle) => {
                        const idProp = circle.properties.properties.id;
                        if (!idProp || !idProp.includes("/")) return false;
                        const id = parseInt(idProp.split("/")[1]);
                        return question.data.same
                            ? nodes.includes(id)
                            : !nodes.includes(id);
                    });
                }
            }

            const englishName = extractStationName(nearestTrainStation);
            if (!englishName) {
                toast?.error("No English name found");
                return current;
            }

            if (question.data.type === "same-first-letter-station") {
                const letter = englishName[0].toUpperCase();
                current = current.filter((circle) => {
                    const name = extractStationName(circle.properties);
                    if (!name) return false;
                    return question.data.same
                        ? name[0].toUpperCase() === letter
                        : name[0].toUpperCase() !== letter;
                });
            } else if (question.data.type === "same-length-station") {
                const seekerLength = englishName.length;
                const comparison = question.data.lengthComparison;
                current = current.filter((circle) => {
                    const name = extractStationName(circle.properties);
                    if (!name) return false;
                    if (comparison === "same")
                        return name.length === seekerLength;
                    if (comparison === "shorter")
                        return name.length < seekerLength;
                    if (comparison === "longer")
                        return name.length > seekerLength;
                    return false;
                });
            }
        }

        if (
            question.id === "measuring" &&
            (question.data.type === "mcdonalds" ||
                question.data.type === "seven11")
        ) {
            if (current.length === 0) break;

            const key =
                question.data.type === "mcdonalds"
                    ? QuestionSpecificLocation.McDonalds
                    : QuestionSpecificLocation.Seven11;
            const points = measuringPoiCache.get(String(key));
            if (!points) continue;

            const seekerPoint = turf.point([
                question.data.lng,
                question.data.lat,
            ]);
            const seekerNearest = turf.nearestPoint(seekerPoint, points as any);
            const seekerDistance = turf.distance(
                seekerPoint,
                seekerNearest as any,
                { units: "miles" },
            );

            current = current.filter((circle) => {
                const point = turf.point(turf.getCoord(circle.properties));
                const nearest = turf.nearestPoint(point, points as any);
                const d = turf.distance(point, nearest as any, {
                    units: "miles",
                });
                return question.data.hiderCloser
                    ? d < seekerDistance + hidingRadius
                    : d > seekerDistance - hidingRadius;
            });
        }
    }

    return current;
}

/**
 * Collect the distinct POI sets needed by this batch of questions, in
 * parallel. Deduplicates: if two questions both need `mcdonalds` we
 * only fire one Overpass request.
 */
export async function prefetchMeasuringPoiPoints(
    questions: Question[],
): Promise<Map<string, FeatureCollection<any>>> {
    const wanted = new Set<string>();
    for (const q of questions) {
        if (q.id !== "measuring") continue;
        if (q.data.type === "mcdonalds") {
            wanted.add(String(QuestionSpecificLocation.McDonalds));
        } else if (q.data.type === "seven11") {
            wanted.add(String(QuestionSpecificLocation.Seven11));
        }
    }

    if (wanted.size === 0) return new Map();

    const entries = await Promise.all(
        [...wanted].map(async (tag) => {
            const pts = await findPlacesSpecificInZone(tag as any);
            return [tag, pts] as const;
        }),
    );
    return new Map(entries);
}

// ---------------------------------------------------------------------------
// Phase B: reachability filter (GTFS / RAPTOR)
// ---------------------------------------------------------------------------

/** Per-station override from the user. */
export type ReachabilityOverride = "include" | "exclude";

/** Classification of a circle against the reachability result. */
export type ReachabilityStatus = "reachable" | "unreachable" | "unknown";

export interface ReachabilityFilterOptions {
    circles: StationCircle[];
    /** OSM→GTFS match table keyed by OSM id (as stored on each place). */
    matches: ReadonlyMap<string, MatchedStation>;
    /** Arrival times from the worker, seconds since departure. */
    arrivalsByStopId: ReadonlyMap<string, number>;
    /** Complete stop table used for parent/platform fallback in arrivals
     *  lookup. Generally the `byId` map of the StopIndex used to build
     *  `matches`. */
    stopById: ReadonlyMap<string, TransitStop>;
    /** Hard cap, minutes, matching the query budget. Circles whose
     *  arrival seconds exceed this are classified "unreachable". */
    budgetMinutes: number;
    /** Per-OSM-id force include / exclude; wins over any automatic
     *  classification. */
    overrides?: ReadonlyMap<string, ReachabilityOverride>;
    /** Decides what to do with circles that have no match in `matches`.
     *  "include" is the sensible default so mis-named or newly opened
     *  stations aren't silently dropped. */
    unknownDefault?: "include" | "exclude";
}

export interface ReachabilityFilterResult {
    /** Circles that survive. */
    filtered: StationCircle[];
    /** OSM id → status, for every input circle (useful for marker
     *  coloring in Phase 4). */
    classifications: Map<string, ReachabilityStatus>;
}

/**
 * Extract the OSM id a circle carries in its `properties` chain.
 * `StationCircle` is a `turf.circle(...)` whose outer properties are the
 * originating `StationPlace` (a GeoJSON Feature<Point>); the OSM id
 * lives at `circle.properties.properties.id`.
 */
function osmIdFromCircle(circle: StationCircle): string | undefined {
    const id = circle.properties?.properties?.id;
    return typeof id === "string" ? id : undefined;
}

/**
 * Split a circle set into reachable / unreachable / unknown using the
 * given OSM↔GTFS matches and a RAPTOR arrivals map. Pure; no store or
 * network access. Overrides are consulted last and always win.
 *
 * Rules:
 *   - No match found → "unknown". Kept iff unknownDefault is "include"
 *     (unless an override says otherwise).
 *   - Match found and stop has an arrival within budget → "reachable".
 *   - Match found and stop has no arrival / arrival > budget →
 *     "unreachable". Dropped unless override "include".
 */
export function filterCirclesByReachability({
    circles,
    matches,
    arrivalsByStopId,
    stopById,
    budgetMinutes,
    overrides,
    unknownDefault = "include",
}: ReachabilityFilterOptions): ReachabilityFilterResult {
    const budgetSec = budgetMinutes * 60;
    const filtered: StationCircle[] = [];
    const classifications = new Map<string, ReachabilityStatus>();

    for (const circle of circles) {
        const osmId = osmIdFromCircle(circle);
        // Circles with no recoverable OSM id (e.g. from custom imports
        // that didn't set one) can't be matched — treat as unknown.
        const match = osmId ? matches.get(osmId) : undefined;

        let status: ReachabilityStatus;
        if (!match || !match.best) {
            status = "unknown";
        } else {
            const arrival = lookupArrivalWithParentFallback(
                match.best.stopId,
                arrivalsByStopId,
                stopById as Map<string, TransitStop>,
            );
            status =
                arrival !== undefined && arrival <= budgetSec
                    ? "reachable"
                    : "unreachable";
        }

        if (osmId) classifications.set(osmId, status);

        const override = osmId ? overrides?.get(osmId) : undefined;
        const keep =
            override === "include"
                ? true
                : override === "exclude"
                  ? false
                  : status === "reachable" ||
                    (status === "unknown" && unknownDefault === "include");

        if (keep) filtered.push(circle);
    }

    return { filtered, classifications };
}

// ---------------------------------------------------------------------------
// Render-side helpers
// ---------------------------------------------------------------------------

/**
 * Stable signature for a set of station circles, used as a memoization
 * key for `styleStations` so toggling unrelated stores doesn't force a
 * fresh `turf.union` over every circle.
 */
export function stationsSignature(
    circles: StationCircle[],
    radius: number,
    units: string,
): string {
    if (circles.length === 0) return `0|${radius}|${units}`;
    // Sort ids so re-ordering doesn't invalidate the key.
    const ids = circles
        .map((c) => c.properties.properties.id)
        .sort()
        .join(",");
    return `${circles.length}|${radius}|${units}|${ids}`;
}
