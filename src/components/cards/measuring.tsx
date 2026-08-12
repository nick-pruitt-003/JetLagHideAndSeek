import { useStore } from "@nanostores/react";
import * as React from "react";
import { toast } from "react-toastify";

import { QuestionCard } from "@/components/cards/base";
import {
    ADMIN_LEVEL_OPTIONS,
    applyLatLng,
    CustomInitChoiceDialog,
    DrawingEnableNotice,
    groupedTypeOptions,
    HidingZoneClickNotice,
    type QuestionCardComponentProps,
    questionCardControls,
    ResultRow,
    ungroupedTypeOptions,
    useQuestionLabel,
} from "@/components/cards/shared";
import { FacilityOsmPlayToggles } from "@/components/FacilityOsmPlayToggles";
import { LatitudeLongitude } from "@/components/LatLngPicker";
import { Select } from "@/components/ui/select";
import {
    MENU_ITEM_CLASSNAME,
    SidebarMenuItem,
} from "@/components/ui/sidebar-l";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
    customInitPreference,
    displayHidingZones,
    hiderMode,
    isLoading,
    questionModified,
    triggerLocalRefresh,
} from "@/lib/context";
import {
    DEFAULT_MEASURING_ADMIN_LEVEL,
    determineMeasuringBoundary,
    findAdminZoneName,
} from "@/maps/questions/measuring";
import {
    type AdminLevel,
    type MeasuringQuestion,
    measuringQuestionSchema,
    type MeasuringQuestionWithAdminZone,
} from "@/maps/schema";

/**
 * Controls for the admin-border question: which admin level to measure against,
 * plus the zone actually found at the seeker's point so the player knows which
 * border the answer is about.
 */
const AdminZoneControls = ({
    data,
    disabled,
}: {
    data: MeasuringQuestionWithAdminZone;
    disabled?: boolean;
}) => {
    const [zone, setZone] = React.useState<{
        loading: boolean;
        name: string | null;
    }>({ loading: true, name: null });

    const adminLevel = data.cat?.adminLevel ?? DEFAULT_MEASURING_ADMIN_LEVEL;

    React.useEffect(() => {
        let cancelled = false;
        setZone({ loading: true, name: null });

        findAdminZoneName(data)
            .then((name) => {
                if (!cancelled) setZone({ loading: false, name });
            })
            .catch(() => {
                if (!cancelled) setZone({ loading: false, name: null });
            });

        return () => {
            cancelled = true;
        };
        // `data` is mutated in place, so depend on the values that change the
        // lookup rather than on the object identity.
    }, [data.lat, data.lng, adminLevel]);

    return (
        <>
            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                <Select
                    trigger="OSM Zone"
                    options={ADMIN_LEVEL_OPTIONS}
                    value={adminLevel.toString()}
                    onValueChange={(value) =>
                        questionModified(
                            (data.cat = {
                                adminLevel: parseInt(value) as AdminLevel,
                            }),
                        )
                    }
                    disabled={disabled}
                />
            </SidebarMenuItem>
            <p className="px-2 text-center text-sm text-muted-foreground">
                {zone.loading ? (
                    "Finding the zone at this location..."
                ) : zone.name ? (
                    <>
                        Measured against the border of{" "}
                        <span className="font-semibold text-foreground">
                            {zone.name}
                        </span>
                        .
                    </>
                ) : (
                    "No zone found at this admin level — try a different one."
                )}
            </p>
        </>
    );
};

export const MeasuringQuestionComponent = ({
    data,
    questionKey,
    sub,
    className,
}: QuestionCardComponentProps<MeasuringQuestion>) => {
    useStore(triggerLocalRefresh);
    const $hiderMode = useStore(hiderMode);
    const $displayHidingZones = useStore(displayHidingZones);
    const $isLoading = useStore(isLoading);
    const $customInitPref = useStore(customInitPreference);
    const [customDialogOpen, setCustomDialogOpen] = React.useState(false);
    const label = useQuestionLabel("measuring", questionKey);

    let questionSpecific = <></>;

    const blankCustomGeo = () => {
        if (!(data as any).geo) {
            (data as any).geo = {
                type: "FeatureCollection",
                features: [],
            };
        } else {
            (data as any).geo.features = [];
        }
    };

    const prefillCustomGeo = async () => {
        let boundary:
            Awaited<ReturnType<typeof determineMeasuringBoundary>> | undefined;

        try {
            boundary = await determineMeasuringBoundary(data);
        } catch (error) {
            // Leave the geometry blank rather than half-written, and say so.
            console.error(
                "Prefilling the custom measuring geometry failed",
                error,
            );
            toast.error(
                "Could not prefill from OpenStreetMap; starting blank.",
            );
        }

        if (!(data as any).geo) {
            (data as any).geo = {
                type: "FeatureCollection",
                features: [],
            };
        }
        (data as any).geo.features = boundary ? boundary : [];
    };

    switch (data.type) {
        case "pick-type":
            questionSpecific = (
                <p className="px-2 text-center text-sm text-muted-foreground">
                    Choose a measuring type above. No coastline, airport, or
                    other fetch runs until you pick one.
                </p>
            );
            break;
        case "city":
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
                <FacilityOsmPlayToggles data={data} questionKey={questionKey} />
            );
            break;
        case "mcdonalds":
        case "seven11":
            questionSpecific = (
                <span className="px-2 text-center text-orange-500">
                    This question will eliminate hiding zones that don&apos;t
                    fit the criteria. When you click on a zone, the parts of
                    that zone that don&apos;t satisfy the criteria will be
                    eliminated.
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
            questionSpecific = <HidingZoneClickNotice />;
            break;
        case "admin-measure":
            questionSpecific = (
                <AdminZoneControls
                    data={data}
                    disabled={!data.drag || $isLoading}
                />
            );
            break;
        case "custom-measure":
            if (data.drag) {
                questionSpecific = (
                    <DrawingEnableNotice
                        subject="the measuring question"
                        questionKey={questionKey}
                        data={data}
                        presetTypeHint={data.type}
                        disabled={!data.drag || $isLoading}
                    />
                );
            }
            break;
    }

    return (
        <QuestionCard
            questionKey={questionKey}
            label={label}
            sub={sub}
            className={className}
            {...questionCardControls(data)}
        >
            <CustomInitChoiceDialog
                open={customDialogOpen}
                onOpenChange={setCustomDialogOpen}
                onChoice={async (choice) => {
                    if (choice === "blank") {
                        blankCustomGeo();
                    } else {
                        await prefillCustomGeo();
                    }
                    data.type = "custom-measure";
                    questionModified();
                    setCustomDialogOpen(false);
                }}
            />
            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                <Select
                    trigger="Measuring Type"
                    options={ungroupedTypeOptions(
                        measuringQuestionSchema.options,
                        "type",
                    )}
                    groups={groupedTypeOptions(
                        measuringQuestionSchema.options,
                        "type",
                        { disabled: !$displayHidingZones },
                    )}
                    value={data.type}
                    onValueChange={async (value) => {
                        if (value === "custom-measure") {
                            if ($customInitPref === "ask") {
                                setCustomDialogOpen(true);
                                return;
                            }
                            if ($customInitPref === "blank") {
                                blankCustomGeo();
                            } else if ($customInitPref === "prefill") {
                                await prefillCustomGeo();
                            }
                        }
                        data.type = value;
                        questionModified();
                    }}
                    disabled={!data.drag || $isLoading}
                />
            </SidebarMenuItem>
            {questionSpecific}
            <LatitudeLongitude
                latitude={data.lat}
                longitude={data.lng}
                colorName={data.color}
                onChange={applyLatLng(data)}
                disabled={!data.drag || $isLoading}
            />
            {data.type !== "pick-type" && (
                <ResultRow>
                    <ToggleGroup
                        className="grow"
                        type="single"
                        value={data.hiderCloser ? "closer" : "further"}
                        onValueChange={(value: "closer" | "further") =>
                            questionModified(
                                (data.hiderCloser = value === "closer"),
                            )
                        }
                        disabled={!!$hiderMode || !data.drag || $isLoading}
                    >
                        <ToggleGroupItem value="further">
                            Hider Further
                        </ToggleGroupItem>
                        <ToggleGroupItem value="closer">
                            Hider Closer
                        </ToggleGroupItem>
                    </ToggleGroup>
                </ResultRow>
            )}
        </QuestionCard>
    );
};
