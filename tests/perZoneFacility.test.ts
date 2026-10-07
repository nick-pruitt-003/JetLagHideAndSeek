import * as turf from "@turf/turf";
import { describe, expect, it } from "vitest";

import {
    facilitiesNearStation,
    seekerFacilityCell,
} from "@/maps/geo-utils/zonePipeline";

const zoo = (lng: number, lat: number, name?: string) =>
    turf.point([lng, lat], name ? { name } : {});

// Seeker in Manhattan; station in the Bronx.
const seeker: [number, number] = [-73.972, 40.768];
const station = turf.point([-73.877, 40.85]);

describe("per-hiding-zone facility questions", () => {
    it("ignores an unnamed facility nearest the seeker instead of wiping every station", () => {
        const facilities = [
            zoo(-73.9721, 40.7681), // unnamed, right next to the seeker
            zoo(-73.9718, 40.7678, "Central Park Zoo"),
            zoo(-73.8773, 40.8506, "Bronx Zoo"),
        ];
        const nearby = facilitiesNearStation(facilities, seeker, station, 0.5);
        expect(nearby?.seekerFacility.properties.name).toBe("Central Park Zoo");
        // Central Park Zoo is too far from this station to be a candidate,
        // so there is no seeker cell: "Same" correctly rules the station out.
        expect(
            seekerFacilityCell(
                nearby!.nearbyFacilities,
                nearby!.seekerFacility,
            ),
        ).toBeUndefined();

        // With a 10-mile hiding radius both zoos are candidates and the
        // seeker's zoo has a cell.
        const wide = facilitiesNearStation(facilities, seeker, station, 10)!;
        const cell = seekerFacilityCell(
            wide.nearbyFacilities,
            wide.seekerFacility,
        );
        expect(cell).toBeDefined();
        expect(turf.booleanPointInPolygon(seeker, cell!)).toBe(true);
        expect(turf.booleanPointInPolygon(station, cell!)).toBe(false);
    });

    it("picks the seeker's own cell when two facilities share a name", () => {
        const facilities = [
            // The other one first, so a lookup by name finds the wrong cell.
            zoo(-73.8773, 40.8506, "City Zoo"),
            zoo(-73.9718, 40.7678, "City Zoo"),
        ];
        const nearby = facilitiesNearStation(facilities, seeker, station, 10)!;
        const cell = seekerFacilityCell(
            nearby.nearbyFacilities,
            nearby.seekerFacility,
        );
        expect(turf.booleanPointInPolygon(seeker, cell!)).toBe(true);
    });

    it("returns null when no facility has a name", () => {
        expect(
            facilitiesNearStation([zoo(-73.9, 40.8)], seeker, station, 1),
        ).toBeNull();
    });
});
