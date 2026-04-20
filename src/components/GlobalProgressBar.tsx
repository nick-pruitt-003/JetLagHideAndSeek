import { useStore } from "@nanostores/react";

import { progressTasksAtom } from "@/lib/progress";
import { cn } from "@/lib/utils";

/**
 * Fixed top-of-viewport progress bar that surfaces background tasks
 * (detailed boundary upgrade, GTFS import, reachability compute, …).
 *
 * - Renders nothing when no tasks are active.
 * - If any task is indeterminate, shows a sweeping shimmer bar.
 * - Otherwise shows the mean of reported fractions; clamped to `>= 5%` so
 *   the bar is visible even right after a task starts.
 * - Flashes red if any task errors, then auto-hides.
 */
export function GlobalProgressBar() {
    const tasks = useStore(progressTasksAtom);

    if (tasks.length === 0) return null;

    const anyIndeterminate = tasks.some(
        (t) => t.status === "running" && t.progress === null,
    );
    const anyError = tasks.some((t) => t.status === "error");

    // Determinate tasks contribute to the visual fraction; indeterminate ones
    // don't, but their presence alone flips us into shimmer mode.
    const determinate = tasks.filter(
        (t) => t.status === "running" && typeof t.progress === "number",
    );
    const meanFraction =
        determinate.length > 0
            ? determinate.reduce((a, t) => a + (t.progress ?? 0), 0) /
              determinate.length
            : 0;
    const percent = Math.max(5, Math.min(100, meanFraction * 100));

    // Show the most recently started task's label as the primary caption.
    const primary = tasks[tasks.length - 1];

    return (
        <div className="fixed top-0 left-0 right-0 z-[10000] pointer-events-none">
            <div
                className={cn(
                    "h-1 w-full overflow-hidden transition-colors duration-200",
                    anyError ? "bg-red-500/20" : "bg-blue-500/20",
                )}
            >
                {anyIndeterminate && !anyError ? (
                    <div
                        role="progressbar"
                        aria-label={primary.label}
                        aria-busy="true"
                        className="h-full w-[40%] bg-blue-500 animate-progress-indeterminate"
                    />
                ) : (
                    <div
                        role="progressbar"
                        aria-label={primary.label}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(percent)}
                        className={cn(
                            "h-full transition-all duration-200 ease-out",
                            anyError ? "bg-red-500" : "bg-blue-500",
                        )}
                        style={{ width: `${percent}%` }}
                    />
                )}
            </div>
            <div className="flex justify-end px-3 pt-1">
                <div
                    className={cn(
                        "pointer-events-auto rounded-md px-2 py-1 text-xs font-medium shadow-md backdrop-blur",
                        anyError
                            ? "bg-red-50/95 text-red-700 dark:bg-red-950/90 dark:text-red-200"
                            : "bg-white/95 text-slate-700 dark:bg-slate-900/90 dark:text-slate-200",
                    )}
                >
                    {primary.label}
                    {tasks.length > 1 && (
                        <span className="ml-1 opacity-60">
                            +{tasks.length - 1}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}
