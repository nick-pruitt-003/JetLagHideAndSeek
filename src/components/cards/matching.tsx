import { useStore } from "@nanostores/react";
import type { Feature, Point } from "geojson";
import { Loader2 } from "lucide-react";
import * as React from "react";
import { toast } from "react-toastify";

import { QuestionCard } from "@/components/cards/base";
import { FacilityOsmPlayToggles } from "@/components/FacilityOsmPlayToggles";
import CustomInitDialog from "@/components/CustomInitDialog";
import { LatitudeLongitude } from "@/components/LatLngPicker";
import PresetsDialog from "@/components/PresetsDialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
    MENU_ITEM_CLASSNAME,
    SidebarMenuItem,
} from "@/components/ui/sidebar-l";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
    additionalMapGeoLocations,
    customInitPreference,
    displayHidingZones,
    drawingQuestionKey,
    hiderMode,
    isLoading,
    mapGeoLocation,
    polyGeoJSON,
    questionModified,
    questions,
    triggerLocalRefresh,
} from "@/lib/context";
import { cn } from "@/lib/utils";
import {
    determineMatchingBoundary,
    findMatchingPlaces,
    listAirportMatchingCandidates,
    normalizeMatchingAirportIata,
} from "@/maps/questions/matching";
import {
    determineUnionizedStrings,
    type MatchingQuestion,
    matchingQuestionSchema,
    NO_GROUP,
} from "@/maps/schema";

function AirportPlayToggles({
    data,
    questionKey,
}: {
    data: MatchingQuestion & { type: "airport" };
    questionKey: number;
}) {
    const $displayHidingZones = useStore(displayHidingZones);
    const $isLoading = useStore(isLoading);
    const $polyGeo = useStore(polyGeoJSON);
    const $mapLoc = useStore(mapGeoLocation);
    const $additional = useStore(additionalMapGeoLocations);
    const [candidates, setCandidates] = React.useState<Feature<Point>[]>([]);
    const [loading, setLoading] = React.useState(false);

    React.useEffect(() => {
        if (!$displayHidingZones) {
            setCandidates([]);
            return;
        }
        let cancelled = false;
        setLoading(true);
        listAirportMatchingCandidates(data)
            .then((pts) => {
                if (!cancelled) setCandidates(pts);
            })
            .catch((err) => {
                console.error("AirportPlayToggles: load candidates failed", err);
                if (!cancelled) setCandidates([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [
        $displayHidingZones,
        questionKey,
        data.activeOnly,
        data.type,
        $polyGeo,
        $mapLoc,
        $additional,
    ]);

    const disabledSet = new Set(
        (data.disabledAirportIatas ?? []).map(normalizeMatchingAirportIata),
    );

    return (
        <>
            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                <div className="flex flex-row items-center justify-between w-full">
                    <Label className="font-semibold">
                        Active airports only?
                    </Label>
                    <Checkbox
                        checked={data.activeOnly}
                        onCheckedChange={(v) =>
                            questionModified((data.activeOnly = !!v))
                        }
                        disabled={!data.drag || $isLoading}
                    />
                </div>
            </SidebarMenuItem>
            <SidebarMenuItem
                className={`${MENU_ITEM_CLASSNAME} flex-col items-stretch gap-2`}
            >
                {!$displayHidingZones ? (
                    <p className="text-xs text-muted-foreground px-1">
                        Turn on hiding zones to load airports for this territory.
                    </p>
                ) : loading ? (
                    <div className="flex justify-center py-2">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                ) : candidates.length === 0 ? (
                    <p className="text-xs text-muted-foreground px-1">
                        No IATA airports found in this territory.
                    </p>
                ) : (
                    <>
                        <Label className="text-xs font-semibold">
                            Airports in play
                        </Label>
                        <p className="text-xs text-muted-foreground">
                            Uncheck to exclude an airport from matching (e.g.
                            TEB, FRG, HVN).
                        </p>
                        <div className="max-h-36 overflow-y-auto space-y-1.5 rounded-md border border-border p-2">
                            {[...candidates]
                                .sort((a, b) =>
                                    String(
                                        (a.properties as { name?: string })
                                            ?.name ?? "",
                                    ).localeCompare(
                                        String(
                                            (b.properties as { name?: string })
                                                ?.name ?? "",
                                        ),
                                    ),
                                )
                                .map((pt) => {
                                    const iata = normalizeMatchingAirportIata(
                                        String(
                                            (pt.properties as { iata?: string })
                                                ?.iata ?? "",
                                        ),
                                    );
                                    const name =
                                        (pt.properties as { name?: string })
                                            ?.name ?? iata;
                                    const inPlay = !disabledSet.has(iata);
                                    return (
                                        <div
                                            key={iata}
                                            className="flex items-start gap-2 text-xs"
                                        >
                                            <Checkbox
                                                className="mt-0.5"
                                                checked={inPlay}
                                                onCheckedChange={(v) => {
                                                    const next = new Set(
                                                        (
                                                            data.disabledAirportIatas ??
                                                            []
                                                        ).map(
                                                            normalizeMatchingAirportIata,
                                                        ),
                                                    );
                                                    if (v === true) next.delete(iata);
                                                    else next.add(iata);
                                                    data.disabledAirportIatas =
                                                        [...next].sort();
                                                    questionModified();
                                                }}
                                                disabled={!data.drag || $isLoading}
                                            />
                                            <span className="min-w-0 leading-snug">
                                                <span className="font-mono tabular-nums">
                                                    {iata}
                                                </span>
                                                {name !== iata ? (
                                                    <span className="text-muted-foreground">
                                                        {" "}
                                                        {name}
                                                    </span>
                                                ) : null}
                                            </span>
                                        </div>
                                    );
                                })}
                        </div>
                    </>
                )}
            </SidebarMenuItem>
        </>
    );
}

export const MatchingQuestionComponent = ({
    data,
    questionKey,
    sub,
    className,
}: {
    data: MatchingQuestion;
    questionKey: number;
    sub?: string;
    className?: string;
}) => {
    useStore(triggerLocalRefresh);
    const $hiderMode = useStore(hiderMode);
    const $questions = useStore(questions);
    const $displayHidingZones = useStore(displayHidingZones);
    const $drawingQuestionKey = useStore(drawingQuestionKey);
    const $isLoading = useStore(isLoading);
    const $customInitPref = useStore(customInitPreference);
    const [customDialogOpen, setCustomDialogOpen] = React.useState(false);
    const [pendingCustomType, setPendingCustomType] = React.useState<
        "custom-zone" | "custom-points" | null
    >(null);
    const label = `Matching
    ${
        $questions
            .filter((q) => q.id === "matching")
            .map((q) => q.key)
            .indexOf(questionKey) + 1
    }`;

    let questionSpecific = <></>;

    switch (data.type) {
        case "zone":
        case "letter-zone":
            questionSpecific = (
                <>
                    <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                        <Select
                            trigger="OSM Zone"
                            options={{
                                2: "OSM Zone 2 (Country)",
                                3: "OSM Zone 3 (region in Japan)",
                                4: "OSM Zone 4 (prefecture in Japan)",
                                5: "OSM Zone 5",
                                6: "OSM Zone 6",
                                7: "OSM Zone 7",
                                8: "OSM Zone 8",
                                9: "OSM Zone 9",
                                10: "OSM Zone 10",
                            }}
                            value={data.cat.adminLevel.toString()}
                            onValueChange={(value) =>
                                questionModified(
                                    (data.cat.adminLevel = parseInt(value) as
                                        | 2
                                        | 3
                                        | 4
                                        | 5
                                        | 6
                                        | 7
                                        | 8
                                        | 9
                                        | 10),
                                )
                            }
                            disabled={!data.drag || $isLoading}
                        />
                    </SidebarMenuItem>
                    {data.type === "letter-zone" && (
                        <span className="px-2 text-center text-orange-500">
                            Warning: The zone data has been simplified by
                            &plusmn;360 feet (100 meters) in order for the
                            browser to not crash.
                        </span>
                    )}
                </>
            );
            break;
        case "airport":
            questionSpecific = (
                <AirportPlayToggles
                    data={data as MatchingQuestion & { type: "airport" }}
                    questionKey={questionKey}
                />
            );
            break;
        case "major-city":
        case "aquarium-full":
        case "zoo-full":
        case "theme_park-full":
        case "peak-full":
        case "museum-full":
        case "hospital-full":
        case "cinema-full":
        case "library-full":
        case "golf_course-full":
        case "consulate-full":
        case "park-full":
            questionSpecific = (
                <FacilityOsmPlayToggles
                    data={data}
                    questionKey={questionKey}
                />
            );
            break;
        case "same-train-line":
            questionSpecific = (
                <span className="px-2 text-center text-orange-500">
                    Warning: The train line data is based on OpenStreetMap and
                    may have fewer train stations than expected. If you are
                    using this tool, ensure that the other players are also
                    using this tool.
                </span>
            );
            break;
        case "aquarium":
        case "hospital":
        case "peak":
        case "museum":
        case "theme_park":
        case "zoo":
        case "cinema":
        case "library":
        case "golf_course":
        case "consulate":
        case "park":
            questionSpecific = (
                <span className="px-2 text-center text-orange-500">
                    This question will only influence the map when you click on
                    a hiding zone in the hiding zone sidebar.
                </span>
            );
            break;
        case "custom-zone":
        case "custom-points":
            if (data.drag) {
                questionSpecific = (
                    <>
                        <p className="px-2 mb-1 text-center text-orange-500">
                            To modify the matching{" "}
                            {data.type === "custom-zone" ? "zones" : "points"},
                            enable it:
                            <Checkbox
                                className="mx-1 my-1"
                                checked={$drawingQuestionKey === questionKey}
                                onCheckedChange={(checked) => {
                                    if (checked) {
                                        drawingQuestionKey.set(questionKey);
                                    } else {
                                        drawingQuestionKey.set(-1);
                                    }
                                }}
                                disabled={$isLoading}
                            />
                            and use the buttons at the bottom left of the map.
                        </p>
                        <div className="flex justify-center mb-2">
                            <PresetsDialog
                                data={data}
                                presetTypeHint={data.type}
                            />
                        </div>
                    </>
                );
            }
    }

    return (
        <QuestionCard
            questionKey={questionKey}
            label={label}
            sub={sub}
            className={className}
            collapsed={data.collapsed}
            setCollapsed={(collapsed) => {
                data.collapsed = collapsed; // Doesn't trigger a re-render so no need for questionModified
            }}
            locked={!data.drag}
            setLocked={(locked) => questionModified((data.drag = !locked))}
        >
            <CustomInitDialog
                open={customDialogOpen}
                onOpenChange={setCustomDialogOpen}
                onBlank={async () => {
                    if (!pendingCustomType) return;
                    if (pendingCustomType === "custom-zone") {
                        (data as any).geo = undefined;
                        toast.info("Please draw the zone on the map.");
                    } else {
                        (data as any).geo = [];
                        toast.info("Please draw the points on the map.");
                    }
                    data.type = pendingCustomType;
                    questionModified();
                    setCustomDialogOpen(false);
                }}
                onPrefill={async () => {
                    if (!pendingCustomType) return;
                    if (pendingCustomType === "custom-zone") {
                        (data as any).geo =
                            await determineMatchingBoundary(data);
                    } else {
                        if (
                            data.type === "airport" ||
                            data.type === "major-city" ||
                            data.type === "aquarium-full" ||
                            data.type === "zoo-full" ||
                            data.type === "theme_park-full" ||
                            data.type === "peak-full" ||
                            data.type === "museum-full" ||
                            data.type === "hospital-full" ||
                            data.type === "cinema-full" ||
                            data.type === "library-full" ||
                            data.type === "golf_course-full" ||
                            data.type === "consulate-full" ||
                            data.type === "park-full"
                        ) {
                            (data as any).geo = await findMatchingPlaces(data);
                        } else {
                            (data as any).geo = [];
                            toast.info("Please draw the points on the map.");
                        }
                    }
                    data.type = pendingCustomType;
                    questionModified();
                    setCustomDialogOpen(false);
                }}
            />
            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                <Select
                    trigger="Matching Type"
                    options={Object.fromEntries(
                        matchingQuestionSchema.options
                            .filter((x) => x.description === NO_GROUP)
                            .flatMap((x) =>
                                determineUnionizedStrings(x.shape.type),
                            )
                            .map((x) => [x.value, x.description]),
                    )}
                    groups={matchingQuestionSchema.options
                        .filter((x) => x.description !== NO_GROUP)
                        .map((x) => [
                            x.description,
                            Object.fromEntries(
                                determineUnionizedStrings(x.shape.type).map(
                                    (x) => [x.value, x.description],
                                ),
                            ),
                        ])
                        .reduce(
                            (acc, [key, value]) => {
                                const values = {
                                    disabled: !$displayHidingZones,
                                    options: value,
                                };

                                if (acc[key]) {
                                    acc[key].options = {
                                        ...acc[key].options,
                                        ...value,
                                    };
                                } else {
                                    acc[key] = values;
                                }

                                return acc;
                            },
                            {} as Record<
                                string,
                                {
                                    disabled: boolean;
                                    options: Record<string, string>;
                                }
                            >,
                        )}
                    value={data.type}
                    onValueChange={async (value) => {
                        if (
                            value === "custom-zone" ||
                            value === "custom-points"
                        ) {
                            if ($customInitPref === "ask") {
                                setPendingCustomType(value);
                                setCustomDialogOpen(true);
                                return;
                            }
                            // Apply preference without dialog
                            if ($customInitPref === "blank") {
                                if (value === "custom-zone") {
                                    (data as any).geo = undefined;
                                    toast.info(
                                        "Please draw the zone on the map.",
                                    );
                                } else {
                                    (data as any).geo = [];
                                    toast.info(
                                        "Please draw the points on the map.",
                                    );
                                }
                            } else if ($customInitPref === "prefill") {
                                if (value === "custom-zone") {
                                    (data as any).geo =
                                        await determineMatchingBoundary(data);
                                } else {
                                    if (
                                        data.type === "airport" ||
                                        data.type === "major-city" ||
                                        data.type === "aquarium-full" ||
                                        data.type === "zoo-full" ||
                                        data.type === "theme_park-full" ||
                                        data.type === "peak-full" ||
                                        data.type === "museum-full" ||
                                        data.type === "hospital-full" ||
                                        data.type === "cinema-full" ||
                                        data.type === "library-full" ||
                                        data.type === "golf_course-full" ||
                                        data.type === "consulate-full" ||
                                        data.type === "park-full"
                                    ) {
                                        (data as any).geo =
                                            await findMatchingPlaces(data);
                                    } else {
                                        (data as any).geo = [];
                                        toast.info(
                                            "Please draw the points on the map.",
                                        );
                                    }
                                }
                            }
                            // The category should be defined such that no error is thrown if this is a zone question.
                            if (!(data as any).cat) {
                                (data as any).cat = { adminLevel: 3 };
                            }
                            questionModified((data.type = value));
                            return;
                        }

                        if (value === "same-length-station") {
                            data.lengthComparison = "same";
                            data.same = true;
                        }

                        // The category should be defined such that no error is thrown if this is a zone question.
                        if (!(data as any).cat) {
                            (data as any).cat = { adminLevel: 3 };
                        }
                        questionModified((data.type = value));
                    }}
                    disabled={!data.drag || $isLoading}
                />
            </SidebarMenuItem>
            {questionSpecific}

            {data.type !== "custom-zone" && (
                <LatitudeLongitude
                    latitude={data.lat}
                    longitude={data.lng}
                    colorName={data.color}
                    onChange={(lat, lng) => {
                        if (lat !== null) {
                            data.lat = lat;
                        }
                        if (lng !== null) {
                            data.lng = lng;
                        }
                        questionModified();
                    }}
                    disabled={!data.drag || $isLoading}
                />
            )}
            <div
                className={cn(
                    "flex gap-2 items-center p-2",
                    data.type === "same-length-station" && "flex-col",
                )}
            >
                <Label
                    className={cn(
                        "font-semibold text-lg",
                        $isLoading && "text-muted-foreground",
                        data.type === "same-length-station" && "text-center",
                    )}
                >
                    Result
                </Label>
                {data.type === "same-length-station" ? (
                    <ToggleGroup
                        className="grow"
                        type="single"
                        value={
                            data.lengthComparison
                                ? data.lengthComparison
                                : data.same === true
                                  ? "same"
                                  : data.same === false
                                    ? "different"
                                    : "same"
                        }
                        onValueChange={(
                            value: "shorter" | "same" | "longer" | "different",
                        ) => {
                            if (value === "shorter" || value === "longer") {
                                questionModified(
                                    (data.lengthComparison = value),
                                );
                            } else if (value === "same") {
                                questionModified(
                                    (data.lengthComparison = "same"),
                                );
                                questionModified((data.same = true));
                            } else if (value === "different") {
                                questionModified((data.same = false));
                            }
                        }}
                        disabled={!!$hiderMode || !data.drag || $isLoading}
                    >
                        <ToggleGroupItem value="shorter">
                            Shorter
                        </ToggleGroupItem>
                        <ToggleGroupItem value="same">Same</ToggleGroupItem>
                        <ToggleGroupItem value="longer">Longer</ToggleGroupItem>
                    </ToggleGroup>
                ) : (
                    <ToggleGroup
                        className="grow"
                        type="single"
                        value={data.same ? "same" : "different"}
                        onValueChange={(value) => {
                            if (value === "same") {
                                questionModified((data.same = true));
                            } else if (value === "different") {
                                questionModified((data.same = false));
                            }
                        }}
                        disabled={!!$hiderMode || !data.drag || $isLoading}
                    >
                        <ToggleGroupItem value="different">
                            Different
                        </ToggleGroupItem>
                        <ToggleGroupItem value="same">Same</ToggleGroupItem>
                    </ToggleGroup>
                )}
            </div>
        </QuestionCard>
    );
};
