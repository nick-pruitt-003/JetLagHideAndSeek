import { describe, expect, it } from "vitest";

import {
    countByOperator,
    type StationLike,
    stationOperatorLabel,
} from "@/lib/station-grouping";

const station = (tags: Record<string, string>): StationLike => ({
    properties: { properties: tags },
});

describe("stationOperatorLabel", () => {
    it("prefers network over operator", () => {
        expect(
            stationOperatorLabel(
                station({
                    network: "MTA New York City Subway",
                    operator: "Metropolitan Transportation Authority",
                }),
            ),
        ).toBe("MTA New York City Subway");
    });

    it("falls back to operator when no network is tagged", () => {
        expect(stationOperatorLabel(station({ operator: "SEPTA" }))).toBe(
            "SEPTA",
        );
    });

    it("attributes a multi-network interchange to its first network", () => {
        expect(
            stationOperatorLabel(
                station({
                    network:
                        "MTA New York City Transit;MTA Long Island Rail Road",
                }),
            ),
        ).toBe("MTA New York City Transit");
    });

    it("recognises an untagged subway station by its mode", () => {
        expect(stationOperatorLabel(station({ station: "subway" }))).toBe(
            "Subway",
        );
        expect(stationOperatorLabel(station({ subway: "yes" }))).toBe("Subway");
    });

    it("falls back to Other for a station with no useful tags", () => {
        expect(stationOperatorLabel(station({ name: "Somewhere" }))).toBe(
            "Other",
        );
        expect(stationOperatorLabel({})).toBe("Other");
        expect(stationOperatorLabel(station({ network: "  " }))).toBe("Other");
    });
});

describe("countByOperator", () => {
    it("counts every station exactly once", () => {
        const stations = [
            station({ network: "MTA New York City Subway" }),
            station({ network: "MTA New York City Subway" }),
            station({ network: "MTA New York City Transit;MTA LIRR" }),
            station({ operator: "SEPTA" }),
            station({ station: "subway" }),
            {},
        ];

        const counts = countByOperator(stations);

        expect(counts).toEqual({
            "MTA New York City Subway": 2,
            "MTA New York City Transit": 1,
            SEPTA: 1,
            Subway: 1,
            Other: 1,
        });
        expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(
            stations.length,
        );
    });

    it("returns nothing for an empty field", () => {
        expect(countByOperator([])).toEqual({});
    });

    it("orders networks by size, largest first", () => {
        const counts = countByOperator([
            station({ network: "SEPTA" }),
            station({ network: "MTA New York City Subway" }),
            station({ network: "MTA New York City Subway" }),
            station({ network: "MTA New York City Subway" }),
            station({ network: "LIRR" }),
            station({ network: "LIRR" }),
        ]);

        expect(Object.keys(counts)).toEqual([
            "MTA New York City Subway",
            "LIRR",
            "SEPTA",
        ]);
    });

    it("breaks ties by first appearance, so the order is stable", () => {
        const counts = countByOperator([
            station({ network: "PATH" }),
            station({ network: "Amtrak" }),
            station({ network: "NJ Transit" }),
        ]);

        expect(Object.keys(counts)).toEqual(["PATH", "Amtrak", "NJ Transit"]);
    });
});
