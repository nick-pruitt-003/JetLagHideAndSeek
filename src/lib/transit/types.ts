/**
 * Type definitions for the transit reachability feature.
 *
 * Two layers of types:
 *   1. Raw GTFS records (the subset we care about from the spec)
 *   2. App-level records (stop/route/trip IDs are prefixed with the owning
 *      systemId so we can mix feeds from multiple agencies without collisions)
 */

// ---------------------------------------------------------------------------
// Raw GTFS record types (subset)
// ---------------------------------------------------------------------------

export interface GtfsStop {
    stop_id: string;
    stop_name: string;
    stop_lat: number;
    stop_lon: number;
    /** 0 or empty = stop/platform, 1 = station, 2 = entrance, 3 = generic, 4 = boarding area */
    location_type?: number;
    parent_station?: string;
    stop_code?: string;
}

export interface GtfsRoute {
    route_id: string;
    agency_id?: string;
    route_short_name?: string;
    route_long_name?: string;
    /** 0 tram, 1 subway, 2 rail, 3 bus, 4 ferry, 5 cable, 6 gondola, 7 funicular, 11 trolleybus, 12 monorail */
    route_type: number;
}

export interface GtfsTrip {
    trip_id: string;
    route_id: string;
    service_id: string;
    trip_headsign?: string;
    direction_id?: number;
    block_id?: string;
}

export interface GtfsStopTime {
    trip_id: string;
    /** Seconds since midnight (GTFS allows >= 24:00:00 for overnight trips) */
    arrival_seconds: number;
    departure_seconds: number;
    stop_id: string;
    stop_sequence: number;
    /** 0 or empty = regular, 1 = no pickup, 2 = phone-required, 3 = coordinate-with-driver */
    pickup_type?: number;
    drop_off_type?: number;
}

export interface GtfsCalendar {
    service_id: string;
    monday: boolean;
    tuesday: boolean;
    wednesday: boolean;
    thursday: boolean;
    friday: boolean;
    saturday: boolean;
    sunday: boolean;
    /** YYYYMMDD */
    start_date: string;
    end_date: string;
}

export interface GtfsCalendarDate {
    service_id: string;
    /** YYYYMMDD */
    date: string;
    /** 1 = service added, 2 = service removed */
    exception_type: 1 | 2;
}

export interface GtfsTransfer {
    from_stop_id: string;
    to_stop_id: string;
    /** 0 recommended, 1 timed, 2 min_transfer_time required, 3 not possible */
    transfer_type: number;
    min_transfer_time?: number;
}

// ---------------------------------------------------------------------------
// App-level record types
// ---------------------------------------------------------------------------

/**
 * A transit system the user has imported. "System" ≈ GTFS feed ≈ single agency
 * or a bundle (e.g. MTA publishes subway + bus as separate feeds; each is its
 * own TransitSystem here).
 */
export interface TransitSystem {
    /** App-assigned, unique across systems (e.g. "nyct-subway"). */
    id: string;
    name: string;
    agency?: string;
    /** Epoch ms. */
    importedAt: number;
    /** Epoch ms of last successful refresh. Same as importedAt on first import. */
    refreshedAt: number;
    /** The URL we fetched from, for refresh. Absent for file uploads. */
    sourceUrl?: string;
    /**
     * How this feed was obtained:
     *   - "direct"        — plain fetch, upstream allowed CORS
     *   - "self-hosted"   — via our /api/proxy-gtfs endpoint (SSR deploys only)
     *   - "public-proxy"  — via corsproxy.io fallback
     *   - "upload"        — user-supplied zip file
     */
    importMethod: "direct" | "self-hosted" | "public-proxy" | "upload";
    stopCount: number;
    tripCount: number;
    /** Route types present in this feed (GTFS codes). Used to filter subway/rail only. */
    routeTypes: number[];
    /** Calendar range (YYYYMMDD) — warns the user if the feed is stale. */
    calendarStart?: string;
    calendarEnd?: string;
}

/**
 * A stop, platform, or station. IDs are prefixed with the systemId so cross-
 * feed routing can't collide on numeric GTFS stop_ids.
 */
export interface TransitStop {
    /** `${systemId}:${gtfsStopId}` */
    id: string;
    systemId: string;
    gtfsStopId: string;
    name: string;
    lat: number;
    lng: number;
    locationType: number;
    /** Prefixed id of the parent station, if any. */
    parentStopId?: string;
}

export interface TransitRoute {
    id: string; // prefixed
    systemId: string;
    gtfsRouteId: string;
    shortName?: string;
    longName?: string;
    routeType: number;
}

export interface TransitTrip {
    id: string; // prefixed
    systemId: string;
    gtfsTripId: string;
    routeId: string; // prefixed
    serviceId: string; // prefixed
    headsign?: string;
    directionId?: number;
}

/**
 * Stop times are stored one record per trip, containing the ordered sequence
 * of stops. Avoids millions of tiny IDB entries on NYC-scale feeds.
 */
export interface TransitTripStopTimes {
    tripId: string; // prefixed
    systemId: string;
    /** Sorted by stop_sequence. Parallel arrays for compact storage. */
    stopIds: string[]; // prefixed
    arrivals: number[]; // seconds since midnight
    departures: number[]; // seconds since midnight
}

export interface TransitService {
    /** `${systemId}:${gtfsServiceId}` */
    id: string;
    systemId: string;
    gtfsServiceId: string;
    /** Bitmask: bit 0 = Monday ... bit 6 = Sunday. */
    daysOfWeek: number;
    startDate: string; // YYYYMMDD
    endDate: string; // YYYYMMDD
    /** Dates where service is explicitly added (date strings YYYYMMDD). */
    additions: string[];
    /** Dates where service is explicitly removed. */
    exceptions: string[];
}

/**
 * A walk/transfer edge between two stops. Stored separately from GTFS
 * transfers so we can distinguish auto-generated ones (and regenerate them
 * when systems are added/removed).
 */
export interface Footpath {
    fromStopId: string; // prefixed
    toStopId: string; // prefixed
    /** Transfer time in seconds. */
    seconds: number;
    source: "gtfs" | "auto-proximity";
}

// ---------------------------------------------------------------------------
// Query types
// ---------------------------------------------------------------------------

export interface ReachabilityQuery {
    origin: { lat: number; lng: number };
    /** Absolute departure time. */
    departureTime: Date;
    budgetMinutes: number;
    walkSpeedMph: number;
    /** Hard cap on any single walking leg (origin→station, station→station, station→dest). */
    maxWalkLegMinutes: number;
    /** System IDs to consider. If empty, use all imported systems. */
    systemIds?: string[];
}

export interface ReachabilityResult {
    query: ReachabilityQuery;
    /** Earliest arrival time (seconds since departureTime) for each reachable stop. */
    arrivalSeconds: Map<string, number>;
    /** Stops we could *walk* to from the origin without any transit. */
    walkReachableStopIds: string[];
    computedAtMs: number;
}

// ---------------------------------------------------------------------------
// Import progress reporting
// ---------------------------------------------------------------------------

export type ImportPhase =
    | "fetching"
    | "unzipping"
    | "parsing-stops"
    | "parsing-routes"
    | "parsing-trips"
    | "parsing-stop-times"
    | "parsing-calendar"
    | "parsing-transfers"
    | "storing"
    | "done";

export interface ImportProgress {
    phase: ImportPhase;
    /** 0..1 overall progress, best-effort. */
    fraction: number;
    message?: string;
}
