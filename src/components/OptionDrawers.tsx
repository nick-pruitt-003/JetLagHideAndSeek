import { useStore } from "@nanostores/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "react-toastify";

import { LatitudeLongitude } from "@/components/LatLngPicker";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Drawer,
    DrawerContent,
    DrawerHeader,
    DrawerTitle,
    DrawerTrigger,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { SidebarMenu } from "@/components/ui/sidebar-l";
import { UnitSelect } from "@/components/UnitSelect";
import {
    additionalMapGeoLocations,
    animateMapMovements,
    autoZoom,
    baseTileLayer,
    cartoApiKey,
    customInitPreference,
    customPresets,
    customStations,
    defaultCustomQuestions,
    defaultUnit,
    disabledStations,
    displayHidingZonesOptions,
    enableBusHubs,
    followMe,
    hiderMode,
    hidingRadius,
    hidingRadiusUnits,
    hidingZone,
    includeDefaultStations,
    leafletMapContext,
    mapGeoJSON,
    mapGeoLocation,
    permanentOverlay,
    planningModeEnabled,
    polyGeoJSON,
    questions,
    reachabilityBudgetMinutes,
    reachabilityDepartureCustomISO,
    reachabilityDeparturePreset,
    reachabilityMaxWalkLegMinutes,
    reachabilityOverrides,
    reachabilitySelectedSystemIds,
    reachabilityWalkSpeedMph,
    showTutorial,
    startingLocation,
    thunderforestApiKey,
    triggerLocalRefresh,
    useCustomStations,
} from "@/lib/context";
import { parseReachabilityPayload } from "@/lib/share/reachability-payload";
import { cn, compress, decompress, shareOrFallback } from "@/lib/utils";
import { questionsSchema } from "@/maps/schema";

const HIDING_ZONE_URL_PARAM = "hz";
const HIDING_ZONE_COMPRESSED_URL_PARAM = "hzc";
/** Retired Pastebin share links; recognised only to explain they no longer work. */
const PASTEBIN_URL_PARAM = "pb";
/**
 * Above this, share data goes after `#` instead of `?`. The query string is
 * sent to the server, and Node rejects request headers over ~16 KB, so a big
 * hand-drawn territory would 431 on load; the fragment never leaves the
 * browser. Short links keep `?` so players on an older cached build can still
 * open them.
 */
const MAX_QUERY_SHARE_URL = 2000;

export const OptionDrawers = ({ className }: { className?: string }) => {
    useStore(triggerLocalRefresh);
    const $defaultCustomQuestions = useStore(defaultCustomQuestions);
    const $defaultUnit = useStore(defaultUnit);
    const $animateMapMovements = useStore(animateMapMovements);
    const $autoZoom = useStore(autoZoom);
    const $hiderMode = useStore(hiderMode);
    const $startingLocation = useStore(startingLocation);
    const $hidingZone = useStore(hidingZone);
    const $planningMode = useStore(planningModeEnabled);
    const $baseTileLayer = useStore(baseTileLayer);
    const $thunderforestApiKey = useStore(thunderforestApiKey);
    const $cartoApiKey = useStore(cartoApiKey);
    const $followMe = useStore(followMe);
    const $customInitPref = useStore(customInitPreference);
    const lastDefaultUnitRef = useRef($defaultUnit);
    const hasSyncedInitialUnitRef = useRef(false);
    const [isOptionsOpen, setIsOptionsOpen] = useState(false);

    useEffect(() => {
        const currentDefault = $defaultUnit;

        if (!hasSyncedInitialUnitRef.current) {
            hasSyncedInitialUnitRef.current = true;
            if (hidingRadiusUnits.get() !== currentDefault) {
                hidingRadiusUnits.set(currentDefault);
            }
        } else if (lastDefaultUnitRef.current !== currentDefault) {
            hidingRadiusUnits.set(currentDefault);
        }

        lastDefaultUnitRef.current = currentDefault;
    }, [$defaultUnit]);

    useEffect(() => {
        const params = new URL(window.location.toString()).searchParams;
        const fragment = new URLSearchParams(window.location.hash.slice(1));
        const hidingZoneOld = params.get(HIDING_ZONE_URL_PARAM);
        const hidingZoneCompressed =
            params.get(HIDING_ZONE_COMPRESSED_URL_PARAM) ??
            fragment.get(HIDING_ZONE_COMPRESSED_URL_PARAM);
        const pastebinId = params.get(PASTEBIN_URL_PARAM);

        if (hidingZoneOld !== null) {
            // Legacy base64 encoding
            try {
                loadHidingZone(atob(hidingZoneOld));
                // Remove hiding zone parameter after initial load
                window.history.replaceState({}, "", window.location.pathname);
            } catch (e) {
                toast.error(`Invalid hiding zone settings: ${e}`);
            }
        } else if (hidingZoneCompressed !== null) {
            // Modern compressed format
            decompress(hidingZoneCompressed).then((data) => {
                try {
                    loadHidingZone(data);
                    // Remove hiding zone parameter after initial load
                    window.history.replaceState(
                        {},
                        "",
                        window.location.pathname,
                    );
                } catch (e) {
                    toast.error(`Invalid hiding zone settings: ${e}`);
                }
            });
        } else if (pastebinId !== null) {
            toast.error(
                "Pastebin share links are no longer supported. Ask for a new share link.",
            );
            window.history.replaceState({}, "", window.location.pathname);
        }
    }, []);

    const loadHidingZone = (hidingZone: string) => {
        try {
            const geojson = JSON.parse(hidingZone);

            if (
                geojson.properties &&
                geojson.properties.isHidingZone === true
            ) {
                questions.set(
                    questionsSchema.parse(geojson.properties.questions ?? []),
                );
                mapGeoLocation.set(geojson);
                mapGeoJSON.set(null);
                polyGeoJSON.set(null);

                if (geojson.alternateLocations) {
                    additionalMapGeoLocations.set(geojson.alternateLocations);
                } else {
                    additionalMapGeoLocations.set([]);
                }
            } else {
                if (geojson.questions) {
                    questions.set(questionsSchema.parse(geojson.questions));
                    delete geojson.questions;

                    mapGeoJSON.set(geojson);
                    polyGeoJSON.set(geojson);
                } else {
                    questions.set([]);
                    mapGeoJSON.set(geojson);
                    polyGeoJSON.set(geojson);
                }
            }

            const incomingPresets =
                geojson.presets ?? geojson.properties?.presets;
            if (incomingPresets && Array.isArray(incomingPresets)) {
                try {
                    const normalized = (incomingPresets as any[])
                        .filter((p) => p && p.data)
                        .map((p) => {
                            return {
                                id:
                                    p.id ??
                                    (typeof crypto !== "undefined" &&
                                    typeof (crypto as any).randomUUID ===
                                        "function"
                                        ? (crypto as any).randomUUID()
                                        : String(Date.now()) + Math.random()),
                                name: p.name ?? "Imported preset",
                                type: p.type ?? "custom",
                                data: p.data,
                                createdAt:
                                    p.createdAt ?? new Date().toISOString(),
                            };
                        });
                    if (normalized.length > 0) {
                        customPresets.set(normalized);
                        toast.info(`Imported ${normalized.length} preset(s)`);
                    }
                } catch (err) {
                    console.warn("Failed to import presets", err);
                    // Share loaded, but the user's custom presets didn't
                    // round-trip — warn them explicitly so they don't
                    // assume everything came through cleanly.
                    toast.warning(
                        "Couldn't import shared presets; the rest of the share loaded successfully.",
                        {
                            toastId: "preset-import-failed",
                            autoClose: 6000,
                        },
                    );
                }
            }

            if (
                geojson.disabledStations !== null &&
                geojson.disabledStations.constructor === Array
            ) {
                disabledStations.set(geojson.disabledStations);
            }

            if (geojson.hidingRadius !== null) {
                hidingRadius.set(geojson.hidingRadius);
            }

            if (geojson.zoneOptions) {
                displayHidingZonesOptions.set(geojson.zoneOptions ?? []);
            }

            if (typeof geojson.useCustomStations === "boolean") {
                useCustomStations.set(geojson.useCustomStations);
            }

            if (
                geojson.customStations &&
                geojson.customStations.constructor === Array
            ) {
                customStations.set(geojson.customStations);
            }

            if (typeof geojson.includeDefaultStations === "boolean") {
                includeDefaultStations.set(geojson.includeDefaultStations);
            }

            if (typeof geojson.busHubs === "boolean") {
                enableBusHubs.set(geojson.busHubs);
            }

            if (geojson.permanentOverlay) {
                permanentOverlay.set(geojson.permanentOverlay);
            } else {
                permanentOverlay.set(null);
            }

            // Starting location (also used as the reachability origin).
            // Older share payloads predate this field; leave the atom
            // alone in that case so the guest keeps whatever they had.
            if (
                geojson.startingLocation === false ||
                (geojson.startingLocation &&
                    typeof geojson.startingLocation === "object" &&
                    typeof geojson.startingLocation.latitude === "number" &&
                    typeof geojson.startingLocation.longitude === "number")
            ) {
                startingLocation.set(geojson.startingLocation);
            }

            // Reachability query + per-station overrides. The parser
            // validates version + field types, so anything it returns
            // is safe to write straight to the persistent atoms.
            const reachability = parseReachabilityPayload(geojson.reachability);
            if (reachability) {
                if (reachability.budgetMinutes !== undefined) {
                    reachabilityBudgetMinutes.set(reachability.budgetMinutes);
                }
                if (reachability.walkSpeedMph !== undefined) {
                    reachabilityWalkSpeedMph.set(reachability.walkSpeedMph);
                }
                if (reachability.maxWalkLegMinutes !== undefined) {
                    reachabilityMaxWalkLegMinutes.set(
                        reachability.maxWalkLegMinutes,
                    );
                }
                if (reachability.departurePreset !== undefined) {
                    reachabilityDeparturePreset.set(
                        reachability.departurePreset,
                    );
                }
                if (reachability.departureCustomISO !== undefined) {
                    reachabilityDepartureCustomISO.set(
                        reachability.departureCustomISO,
                    );
                }
                if (reachability.selectedSystemIds !== undefined) {
                    reachabilitySelectedSystemIds.set(
                        reachability.selectedSystemIds,
                    );
                }
                if (reachability.overrides !== undefined) {
                    reachabilityOverrides.set(reachability.overrides);
                }
            }

            toast.success("Hiding zone loaded successfully", {
                autoClose: 2000,
            });
        } catch (e) {
            toast.error(`Invalid hiding zone settings: ${e}`);
        }
    };

    return (
        <div
            className={cn(
                "flex justify-end gap-2 max-[412px]:mb-4! max-[340px]:flex-col",
                className,
            )}
        >
            <Button
                className="shadow-md"
                onClick={async () => {
                    const hidingZoneString = JSON.stringify($hidingZone);
                    let compressedData;
                    try {
                        compressedData = await compress(hidingZoneString);
                    } catch (error) {
                        console.error("Compression failed:", error);
                        toast.error(`Failed to prepare data for sharing`);
                        return;
                    }

                    const baseUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}`;
                    let shareUrl = `${baseUrl}?${HIDING_ZONE_COMPRESSED_URL_PARAM}=${compressedData}`;
                    if (shareUrl.length > MAX_QUERY_SHARE_URL) {
                        shareUrl = `${baseUrl}#${HIDING_ZONE_COMPRESSED_URL_PARAM}=${compressedData}`;
                    }

                    // Show platform native share sheet if possible
                    await shareOrFallback(shareUrl).then((result) => {
                        if (result === "cancelled") return;

                        if (result === false) {
                            return toast.error(
                                `Clipboard not supported. Try manually copying/pasting: ${shareUrl}`,
                                { className: "p-0 w-[1000px]" },
                            );
                        }

                        if (result === "clipboard") {
                            toast.success(
                                "Hiding zone URL copied to clipboard",
                                {
                                    autoClose: 2000,
                                },
                            );
                        }
                    });
                }}
                data-tutorial-id="share-questions-button"
            >
                Share
            </Button>
            <Button
                className="w-24 shadow-md"
                onClick={() => {
                    showTutorial.set(true);
                }}
            >
                Tutorial
            </Button>
            <Drawer open={isOptionsOpen} onOpenChange={setIsOptionsOpen}>
                <DrawerTrigger className="w-24" asChild>
                    <Button
                        className="w-24 shadow-md"
                        data-tutorial-id="option-questions-button"
                    >
                        Options
                    </Button>
                </DrawerTrigger>
                <DrawerContent>
                    <div className="flex flex-col items-center gap-4 mb-4">
                        <DrawerHeader>
                            <DrawerTitle className="text-4xl font-semibold font-poppins">
                                Options
                            </DrawerTitle>
                        </DrawerHeader>
                        <div className="overflow-y-scroll max-h-[40vh] max-md:max-h-[65vh] flex flex-col items-center gap-4 max-w-[1000px] px-12">
                            <div className="flex flex-row max-[330px]:flex-col gap-4">
                                <Button
                                    onClick={() => {
                                        if (!navigator || !navigator.clipboard)
                                            return toast.error(
                                                "Clipboard not supported",
                                            );
                                        navigator.clipboard.writeText(
                                            JSON.stringify($hidingZone),
                                        );
                                        toast.success(
                                            "Hiding zone copied successfully",
                                            {
                                                autoClose: 2000,
                                            },
                                        );
                                    }}
                                >
                                    Copy Hiding Zone
                                </Button>
                                <Button
                                    onClick={() => {
                                        if (!navigator || !navigator.clipboard)
                                            return toast.error(
                                                "Clipboard not supported",
                                            );
                                        navigator.clipboard
                                            .readText()
                                            .then(loadHidingZone);
                                    }}
                                >
                                    Paste Hiding Zone
                                </Button>
                            </div>
                            {/* Same JSON as Copy/Paste, as a file: no size
                                limit, and it survives chat apps that mangle
                                long links. */}
                            <div className="flex flex-row max-[330px]:flex-col gap-4">
                                <Button
                                    onClick={() => {
                                        const blob = new Blob(
                                            [JSON.stringify($hidingZone)],
                                            { type: "application/json" },
                                        );
                                        const url = URL.createObjectURL(blob);
                                        const link =
                                            document.createElement("a");
                                        link.href = url;
                                        link.download = `jetlag-game-${new Date()
                                            .toISOString()
                                            .slice(0, 10)}.json`;
                                        link.click();
                                        setTimeout(
                                            () => URL.revokeObjectURL(url),
                                            1000,
                                        );
                                    }}
                                >
                                    Save Game to File
                                </Button>
                                <Button asChild>
                                    <label className="cursor-pointer">
                                        Open Game File
                                        <input
                                            type="file"
                                            accept=".json,application/json"
                                            className="sr-only"
                                            onChange={async (e) => {
                                                const file =
                                                    e.target.files?.[0];
                                                e.target.value = "";
                                                if (!file) return;
                                                try {
                                                    loadHidingZone(
                                                        await file.text(),
                                                    );
                                                } catch (error) {
                                                    toast.error(
                                                        `Couldn't read that file: ${error}`,
                                                    );
                                                }
                                            }}
                                        />
                                    </label>
                                </Button>
                            </div>
                            <Separator className="bg-slate-300 w-[280px]" />
                            <Label>Default Unit</Label>
                            <UnitSelect
                                unit={$defaultUnit}
                                onChange={defaultUnit.set}
                            />
                            <Separator className="bg-slate-300 w-[280px]" />
                            <Label>New Custom Question Defaults</Label>
                            <Select
                                trigger="New custom default"
                                options={{
                                    ask: "Ask each time",
                                    blank: "Start blank",
                                    prefill: "Copy from current",
                                }}
                                value={$customInitPref}
                                onValueChange={(v) =>
                                    customInitPreference.set(v as any)
                                }
                            />
                            <Separator className="bg-slate-300 w-[280px]" />
                            <Label>Base map style</Label>
                            <Select
                                trigger="Base map style"
                                groups={{
                                    // Grouped by provider, vector first within
                                    // each: the list is long enough now that a
                                    // flat one buries the raster/vector pairs.
                                    CARTO: {
                                        "voyager-vector": "Voyager",
                                        "light-vector": "Light",
                                        "dark-vector": "Dark",
                                        voyager: "Voyager (raster)",
                                        light: "Light (raster)",
                                        dark: "Dark (raster)",
                                    },
                                    Thunderforest: {
                                        "transport-vector": "Transport",
                                        "transport-dark-vector":
                                            "Transport Dark",
                                        "atlas-vector": "Atlas",
                                        transport: "Transport (raster)",
                                        neighbourhood: "Neighbourhood (raster)",
                                        pioneer: "Pioneer (raster)",
                                    },
                                    OpenFreeMap: {
                                        "openfreemap-liberty": "Liberty",
                                        "openfreemap-dark": "Dark",
                                    },
                                    OpenStreetMap: {
                                        osmcarto: "Carto (raster)",
                                    },
                                }}
                                value={$baseTileLayer}
                                onValueChange={(v) =>
                                    baseTileLayer.set(v as any)
                                }
                            />
                            <div className="flex flex-col items-center gap-2">
                                <Label htmlFor="cartoApiKey">
                                    CARTO API Key
                                </Label>
                                <Input
                                    type="text"
                                    value={$cartoApiKey}
                                    id="cartoApiKey"
                                    onChange={(e) =>
                                        cartoApiKey.set(e.target.value)
                                    }
                                    placeholder="Enter your CARTO API key"
                                />
                                <p className="text-xs text-muted-foreground">
                                    Needed for the CARTO raster styles — without
                                    it they fall back to plain OpenStreetMap
                                    tiles. The vector styles work either way,
                                    are sharper at high zoom, and are what CARTO
                                    is moving to; the same key covers both. Get
                                    a free key from the{" "}
                                    <a
                                        href="https://carto.com/basemaps/apikey"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-blue-500 cursor-pointer"
                                    >
                                        CARTO Basemaps API key page
                                    </a>
                                    .
                                </p>
                            </div>
                            <Separator className="bg-slate-300 w-[280px]" />
                            <div className="flex flex-col items-center gap-2">
                                <Label htmlFor="thunderforestApiKey">
                                    Thunderforest API Key
                                </Label>
                                <Input
                                    type="text"
                                    value={$thunderforestApiKey}
                                    id="thunderforestApiKey"
                                    onChange={(e) =>
                                        thunderforestApiKey.set(e.target.value)
                                    }
                                    placeholder="Enter your Thunderforest API key"
                                />
                                <p className="text-xs text-muted-foreground">
                                    Needed for Thunderforest map styles. Create
                                    a key on the{" "}
                                    <a
                                        href="https://manage.thunderforest.com/users/sign_up?price=hobby-project-usd"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-blue-500 cursor-pointer"
                                    >
                                        Thunderforest sign-up page
                                    </a>
                                    . Don&apos;t worry, it&apos;s free.
                                </p>
                            </div>
                            <Separator className="bg-slate-300 w-[280px]" />
                            <Separator className="bg-slate-300 w-[280px]" />
                            <Label>Permanent Map Overlay</Label>
                            <div className="flex flex-row max-[330px]:flex-col gap-4">
                                <Button
                                    onClick={() => permanentOverlay.set(null)}
                                >
                                    Remove
                                </Button>
                                <Button
                                    onClick={async () => {
                                        if (!navigator || !navigator.clipboard)
                                            return toast.error(
                                                "Clipboard not supported",
                                            );

                                        try {
                                            const clipboard =
                                                await navigator.clipboard.readText();
                                            const geojson =
                                                JSON.parse(clipboard);
                                            permanentOverlay.set(geojson);
                                        } catch (e) {
                                            toast.error(
                                                `Invalid GeoJSON overlay: ${e}`,
                                            );
                                        }
                                    }}
                                >
                                    Paste GeoJSON
                                </Button>
                            </div>
                            <Separator className="bg-slate-300 w-[280px]" />
                            <label className="flex flex-row items-center gap-2 cursor-pointer text-2xl font-semibold font-poppins">
                                Animate map movements?
                                <Checkbox
                                    checked={$animateMapMovements}
                                    onCheckedChange={() => {
                                        animateMapMovements.set(
                                            !$animateMapMovements,
                                        );
                                    }}
                                />
                            </label>
                            <label className="flex flex-row items-center gap-2 cursor-pointer text-2xl font-semibold font-poppins">
                                Enable planning mode?
                                <Checkbox
                                    checked={$planningMode}
                                    onCheckedChange={() => {
                                        if ($planningMode === true) {
                                            const map = leafletMapContext.get();

                                            if (map) {
                                                map.eachLayer((layer: any) => {
                                                    if (
                                                        layer.questionKey ||
                                                        layer.questionKey === 0
                                                    ) {
                                                        map.removeLayer(layer);
                                                    }
                                                });
                                            }
                                        } else {
                                            questions.set([...questions.get()]); // I think that this should always be auto-saved
                                        }

                                        planningModeEnabled.set(!$planningMode);
                                    }}
                                />
                            </label>
                            <label className="flex flex-row items-center gap-2 cursor-pointer text-2xl font-semibold font-poppins">
                                Auto zoom?
                                <Checkbox
                                    checked={$autoZoom}
                                    onCheckedChange={() =>
                                        autoZoom.set(!$autoZoom)
                                    }
                                />
                            </label>
                            <label className="flex flex-row items-center gap-2 cursor-pointer text-2xl font-semibold font-poppins">
                                Follow Me (GPS)?
                                <Checkbox
                                    checked={$followMe}
                                    onCheckedChange={() =>
                                        followMe.set(!$followMe)
                                    }
                                />
                            </label>
                            <label className="flex flex-row items-center gap-2 cursor-pointer text-2xl font-semibold font-poppins">
                                Default to custom questions?
                                <Checkbox
                                    checked={$defaultCustomQuestions}
                                    onCheckedChange={() =>
                                        defaultCustomQuestions.set(
                                            !$defaultCustomQuestions,
                                        )
                                    }
                                />
                            </label>
                            <label className="flex flex-row items-center gap-2 cursor-pointer text-2xl font-semibold font-poppins">
                                Hider mode?
                                <Checkbox
                                    checked={!!$hiderMode}
                                    onCheckedChange={() => {
                                        if ($hiderMode === false) {
                                            const $leafletMapContext =
                                                leafletMapContext.get();

                                            if ($leafletMapContext) {
                                                const center =
                                                    $leafletMapContext.getCenter();
                                                hiderMode.set({
                                                    latitude: center.lat,
                                                    longitude: center.lng,
                                                });
                                            } else {
                                                hiderMode.set({
                                                    latitude: 0,
                                                    longitude: 0,
                                                });
                                            }
                                        } else {
                                            hiderMode.set(false);
                                        }
                                    }}
                                />
                            </label>
                            {$hiderMode !== false && (
                                <SidebarMenu>
                                    <LatitudeLongitude
                                        latitude={$hiderMode.latitude}
                                        longitude={$hiderMode.longitude}
                                        inlineEdit
                                        onChange={(latitude, longitude) => {
                                            $hiderMode.latitude =
                                                latitude ?? $hiderMode.latitude;
                                            $hiderMode.longitude =
                                                longitude ??
                                                $hiderMode.longitude;

                                            hiderMode.set({
                                                ...$hiderMode,
                                            });
                                        }}
                                        label="Hider Location"
                                    />
                                </SidebarMenu>
                            )}
                            <label className="flex flex-row items-center gap-2 cursor-pointer text-2xl font-semibold font-poppins">
                                Starting location?
                                <Checkbox
                                    checked={!!$startingLocation}
                                    onCheckedChange={() => {
                                        if ($startingLocation === false) {
                                            const $leafletMapContext =
                                                leafletMapContext.get();

                                            if ($leafletMapContext) {
                                                const center =
                                                    $leafletMapContext.getCenter();
                                                startingLocation.set({
                                                    latitude: center.lat,
                                                    longitude: center.lng,
                                                });
                                            } else {
                                                startingLocation.set({
                                                    latitude: 0,
                                                    longitude: 0,
                                                });
                                            }
                                        } else {
                                            startingLocation.set(false);
                                        }
                                    }}
                                />
                            </label>
                            {$startingLocation !== false && (
                                <SidebarMenu>
                                    <LatitudeLongitude
                                        latitude={$startingLocation.latitude}
                                        longitude={$startingLocation.longitude}
                                        inlineEdit
                                        onChange={(latitude, longitude) => {
                                            $startingLocation.latitude =
                                                latitude ??
                                                $startingLocation.latitude;
                                            $startingLocation.longitude =
                                                longitude ??
                                                $startingLocation.longitude;

                                            startingLocation.set({
                                                ...$startingLocation,
                                            });
                                        }}
                                        label="Starting Location"
                                    />
                                </SidebarMenu>
                            )}
                        </div>
                    </div>
                </DrawerContent>
            </Drawer>
        </div>
    );
};
