/**
 * Transit Systems manager dialog.
 *
 * Lists imported GTFS feeds and lets the user add/remove them. Importing
 * runs in-thread (GTFS parse is synchronous via fflate + papaparse); the
 * UI updates progress via the `onProgress` callback on `parseGtfs`.
 *
 * Minimal per-row UI for now: name, stop count, delete. Storage usage,
 * enable toggles, and last-refreshed come in Phase 5 polish.
 *
 * Curated presets (NYCT, LIRR, MNR, NJT, SLE) slot into the empty
 * presets section and come in the follow-up p4-presets task.
 */
import React, { useEffect, useRef, useState } from "react";
import { Loader2, Trash2, Upload, Globe, Plus } from "lucide-react";
import { toast } from "react-toastify";

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

import {
    deleteSystem,
    listSystems,
    writeSystemBulk,
} from "@/lib/transit/gtfs-store";
import { parseGtfs } from "@/lib/transit/gtfs-parser";
import { fetchGtfsZip, looksLikeZip } from "@/lib/transit/cors-proxy";
import { rebuildAutoTransfers } from "@/lib/transit/auto-transfers";
import { reachabilityClient } from "@/lib/transit/reachability-client";
import type { ImportProgress, TransitSystem } from "@/lib/transit/types";

interface TransitSystemsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

/**
 * Slugify a user-supplied name into a systemId. Collisions are handled by
 * the caller appending `-2`, `-3`, etc.
 */
function slugify(name: string): string {
    return (
        name
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "system"
    );
}

async function uniqueSystemId(base: string): Promise<string> {
    const existing = await listSystems();
    const taken = new Set(existing.map((s) => s.id));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
        const candidate = `${base}-${i}`;
        if (!taken.has(candidate)) return candidate;
    }
    // Absurd fallback — user has 1000 collisions. Use a random suffix.
    return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Human label for a progress phase. Kept short — lives inside a small
 * status line, not a full log.
 */
function phaseLabel(phase: ImportProgress["phase"]): string {
    switch (phase) {
        case "fetching":
            return "Downloading feed";
        case "unzipping":
            return "Unzipping";
        case "parsing-stops":
            return "Parsing stops";
        case "parsing-routes":
            return "Parsing routes";
        case "parsing-trips":
            return "Parsing trips";
        case "parsing-stop-times":
            return "Parsing stop times";
        case "parsing-calendar":
            return "Parsing calendar";
        case "parsing-transfers":
            return "Parsing transfers";
        case "storing":
            return "Saving to device";
        case "done":
            return "Done";
    }
}

export default function TransitSystemsDialog({
    open,
    onOpenChange,
}: TransitSystemsDialogProps) {
    const [systems, setSystems] = useState<TransitSystem[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [urlInput, setUrlInput] = useState("");
    const [nameInput, setNameInput] = useState("");
    const [progress, setProgress] = useState<ImportProgress | null>(null);
    const [deleting, setDeleting] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const abortRef = useRef<AbortController | null>(null);

    // Fetch list every time the dialog opens — IDB is the source of truth
    // and other paths (presets, auto-refresh) may have mutated it.
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setSystems(null);
        listSystems()
            .then((s) => {
                if (!cancelled) {
                    // Sort by most-recently imported first.
                    s.sort((a, b) => b.importedAt - a.importedAt);
                    setSystems(s);
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    console.log("Failed to list transit systems:", err);
                    toast.error("Couldn't read saved transit systems");
                    setSystems([]);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [open]);

    // Abort any in-flight fetch when the dialog closes.
    useEffect(() => {
        if (!open && abortRef.current) {
            abortRef.current.abort();
            abortRef.current = null;
        }
    }, [open]);

    const refreshList = async () => {
        const s = await listSystems();
        s.sort((a, b) => b.importedAt - a.importedAt);
        setSystems(s);
    };

    const handleImport = async (
        source: { kind: "url"; url: string } | { kind: "file"; file: File },
    ) => {
        if (loading) return;

        const rawName =
            nameInput.trim() ||
            (source.kind === "file"
                ? source.file.name.replace(/\.zip$/i, "")
                : source.url.split("/").pop()?.replace(/\.zip.*$/i, "") ||
                  "Imported system");

        const baseId = slugify(rawName);
        const systemId = await uniqueSystemId(baseId);

        setLoading(true);
        setProgress({ phase: "fetching", fraction: 0, message: "" });

        const onProgress = (p: ImportProgress) => setProgress(p);

        try {
            let bytes: ArrayBuffer;
            let importMethod: TransitSystem["importMethod"];

            if (source.kind === "file") {
                const buf = await source.file.arrayBuffer();
                if (!looksLikeZip(buf)) {
                    throw new Error(
                        "That file doesn't look like a GTFS zip (missing zip header).",
                    );
                }
                bytes = buf;
                importMethod = "upload";
            } else {
                abortRef.current = new AbortController();
                const result = await fetchGtfsZip(
                    source.url,
                    (loaded, total) => {
                        onProgress({
                            phase: "fetching",
                            fraction: total
                                ? Math.min(0.1, (loaded / total) * 0.1)
                                : 0.05,
                            message: `${(loaded / 1024 / 1024).toFixed(1)} MB`,
                        });
                    },
                    abortRef.current.signal,
                );
                if (!looksLikeZip(result.bytes)) {
                    throw new Error(
                        "Server returned non-zip content. The URL may require a different fetch method — try downloading manually and uploading the zip.",
                    );
                }
                bytes = result.bytes;
                importMethod = result.method;
            }

            const parsed = await parseGtfs(bytes, {
                systemId,
                name: rawName,
                sourceUrl: source.kind === "url" ? source.url : undefined,
                importMethod,
                onProgress,
            });

            onProgress({ phase: "storing", fraction: 0.9 });
            await writeSystemBulk({
                system: parsed.system,
                stops: parsed.stops,
                routes: parsed.routes,
                trips: parsed.trips,
                stopTimes: parsed.tripStopTimes,
                services: parsed.services,
                transfers: parsed.gtfsTransfers,
            });

            // Auto-transfers cross systems, so rebuild after every add.
            // Don't block the UI on this — the system is already saved.
            onProgress({ phase: "done", fraction: 1 });
            rebuildAutoTransfers().catch((err) => {
                console.log("Auto-transfer rebuild failed:", err);
            });
            // Force the RAPTOR worker to drop its cached graph so the
            // next reachability query sees the new feed.
            reachabilityClient.invalidate();

            toast.success(
                `Imported ${parsed.system.name} (${parsed.stops.length.toLocaleString()} stops)`,
            );
            setUrlInput("");
            setNameInput("");
            if (fileInputRef.current) fileInputRef.current.value = "";
            await refreshList();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log("GTFS import failed:", err);
            toast.error(`Import failed: ${msg}`, {
                toastId: "gtfs-import-error",
                autoClose: 8000,
            });
        } finally {
            setLoading(false);
            setProgress(null);
            abortRef.current = null;
        }
    };

    const handleDelete = async (system: TransitSystem) => {
        if (deleting) return;
        // Match the existing confirm pattern elsewhere in the app.
        if (
            !window.confirm(
                `Remove "${system.name}"? This deletes all its stops, trips, and schedules from your device.`,
            )
        ) {
            return;
        }
        setDeleting(system.id);
        try {
            await deleteSystem(system.id);
            toast.success(`Removed ${system.name}`);
            // Transfers cross systems; rebuild after delete too.
            rebuildAutoTransfers().catch((err) => {
                console.log("Auto-transfer rebuild failed:", err);
            });
            reachabilityClient.invalidate();
            await refreshList();
        } catch (err) {
            console.log("Delete system failed:", err);
            toast.error("Couldn't remove that system");
        } finally {
            setDeleting(null);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-xl max-h-[85vh] flex flex-col">
                <DialogHeader>
                    <DialogTitle>Transit systems</DialogTitle>
                    <DialogDescription>
                        Import GTFS feeds to enable reachability filtering.
                        Feeds are stored on your device and never sent to a
                        server.
                    </DialogDescription>
                </DialogHeader>

                {/* Installed systems list */}
                <div className="flex-1 overflow-y-auto space-y-4 py-2">
                    <section>
                        <h3 className="text-sm font-semibold mb-2">
                            Installed
                        </h3>
                        {systems === null ? (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Loading…
                            </div>
                        ) : systems.length === 0 ? (
                            <p className="text-sm text-muted-foreground py-2">
                                No feeds imported yet. Add one below.
                            </p>
                        ) : (
                            <ul className="space-y-1">
                                {systems.map((s) => (
                                    <li
                                        key={s.id}
                                        className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                                    >
                                        <div className="min-w-0">
                                            <div className="font-medium truncate">
                                                {s.name}
                                            </div>
                                            <div className="text-xs text-muted-foreground truncate">
                                                {s.stopCount.toLocaleString()}{" "}
                                                stops ·{" "}
                                                {new Date(
                                                    s.importedAt,
                                                ).toLocaleDateString()}
                                            </div>
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => handleDelete(s)}
                                            disabled={
                                                deleting === s.id || loading
                                            }
                                            aria-label={`Remove ${s.name}`}
                                        >
                                            {deleting === s.id ? (
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                            ) : (
                                                <Trash2 className="h-4 w-4" />
                                            )}
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>

                    {/* Curated presets — filled in by p4-presets. */}
                    <section>
                        <h3 className="text-sm font-semibold mb-2">
                            Curated presets
                        </h3>
                        <p className="text-sm text-muted-foreground">
                            One-click installs for common agencies coming
                            soon (NYCT, LIRR, Metro-North, NJ Transit, SLE).
                        </p>
                    </section>

                    {/* Import from URL / file */}
                    <section className="space-y-3">
                        <h3 className="text-sm font-semibold">Add a feed</h3>

                        <div className="space-y-1.5">
                            <Label
                                htmlFor="transit-name"
                                className="text-xs font-medium"
                            >
                                Name (optional)
                            </Label>
                            <Input
                                id="transit-name"
                                placeholder="e.g. Boston MBTA Rail"
                                value={nameInput}
                                onChange={(e) => setNameInput(e.target.value)}
                                disabled={loading}
                            />
                        </div>

                        <div className="space-y-1.5">
                            <Label
                                htmlFor="transit-url"
                                className="text-xs font-medium"
                            >
                                GTFS zip URL
                            </Label>
                            <div className="flex gap-2">
                                <Input
                                    id="transit-url"
                                    placeholder="https://…/google_transit.zip"
                                    value={urlInput}
                                    onChange={(e) =>
                                        setUrlInput(e.target.value)
                                    }
                                    disabled={loading}
                                    onKeyDown={(e) => {
                                        if (
                                            e.key === "Enter" &&
                                            urlInput.trim()
                                        ) {
                                            handleImport({
                                                kind: "url",
                                                url: urlInput.trim(),
                                            });
                                        }
                                    }}
                                />
                                <Button
                                    onClick={() =>
                                        handleImport({
                                            kind: "url",
                                            url: urlInput.trim(),
                                        })
                                    }
                                    disabled={!urlInput.trim() || loading}
                                >
                                    <Globe className="h-4 w-4 mr-1.5" />
                                    Fetch
                                </Button>
                            </div>
                        </div>

                        <div className="space-y-1.5">
                            <Label className="text-xs font-medium">
                                …or upload a zip
                            </Label>
                            <div className="flex gap-2">
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept=".zip,application/zip"
                                    className="hidden"
                                    onChange={(e) => {
                                        const file = e.target.files?.[0];
                                        if (file) {
                                            handleImport({
                                                kind: "file",
                                                file,
                                            });
                                        }
                                    }}
                                    disabled={loading}
                                />
                                <Button
                                    variant="outline"
                                    onClick={() =>
                                        fileInputRef.current?.click()
                                    }
                                    disabled={loading}
                                    className="w-full"
                                >
                                    <Upload className="h-4 w-4 mr-1.5" />
                                    Choose GTFS zip…
                                </Button>
                            </div>
                        </div>

                        {progress && (
                            <div className="space-y-1">
                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    <span>
                                        {phaseLabel(progress.phase)}
                                        {progress.message
                                            ? ` · ${progress.message}`
                                            : ""}
                                    </span>
                                </div>
                                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                                    <div
                                        className={cn(
                                            "h-full bg-primary transition-all duration-200",
                                        )}
                                        style={{
                                            width: `${Math.round(
                                                Math.max(
                                                    0,
                                                    Math.min(
                                                        1,
                                                        progress.fraction,
                                                    ),
                                                ) * 100,
                                            )}%`,
                                        }}
                                    />
                                </div>
                            </div>
                        )}
                    </section>
                </div>

                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={loading}
                    >
                        {loading ? "Importing…" : "Close"}
                    </Button>
                    {loading && abortRef.current && (
                        <Button
                            variant="ghost"
                            onClick={() => abortRef.current?.abort()}
                        >
                            Cancel download
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Compact inline trigger you can drop anywhere. Keeps the dialog's state
 * self-contained so callers don't have to wire `open` manually.
 */
export function TransitSystemsButton({
    className,
    variant = "outline",
    children,
}: {
    className?: string;
    variant?: React.ComponentProps<typeof Button>["variant"];
    children?: React.ReactNode;
}) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button
                variant={variant}
                className={className}
                onClick={() => setOpen(true)}
                type="button"
            >
                <Plus className="h-4 w-4 mr-1.5" />
                {children ?? "Manage transit systems"}
            </Button>
            <TransitSystemsDialog open={open} onOpenChange={setOpen} />
        </>
    );
}
