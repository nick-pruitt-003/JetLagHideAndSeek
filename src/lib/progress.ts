import { atom } from "nanostores";

export type ProgressStatus = "running" | "error";

export interface ProgressTask {
    id: string;
    label: string;
    /** 0..1, or null for indeterminate (spinner-style bar). */
    progress: number | null;
    status: ProgressStatus;
    startedAt: number;
}

/**
 * Global registry of in-flight tasks surfaced by {@link GlobalProgressBar}.
 * Multiple tasks can run concurrently (e.g. boundary upgrade + GTFS import).
 */
export const progressTasksAtom = atom<ProgressTask[]>([]);

let _taskCounter = 0;
const nextId = (): string => `task-${Date.now()}-${++_taskCounter}`;

export interface StartTaskOpts {
    label: string;
    /** Defaults to `null` (indeterminate). */
    progress?: number | null;
    /** Supply to reuse an id across re-mounts; otherwise auto-generated. */
    id?: string;
}

export function startTask(opts: StartTaskOpts): string {
    const id = opts.id ?? nextId();
    const task: ProgressTask = {
        id,
        label: opts.label,
        progress: opts.progress ?? null,
        status: "running",
        startedAt: Date.now(),
    };
    // Replace any existing task with the same id (idempotent re-start).
    const existing = progressTasksAtom.get().filter((t) => t.id !== id);
    progressTasksAtom.set([...existing, task]);
    return id;
}

export interface UpdateTaskPatch {
    label?: string;
    progress?: number | null;
}

export function updateTask(id: string, patch: UpdateTaskPatch): void {
    const tasks = progressTasksAtom.get();
    if (!tasks.some((t) => t.id === id)) return;
    progressTasksAtom.set(
        tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
}

/** Remove the task immediately (normal completion). */
export function finishTask(id: string): void {
    progressTasksAtom.set(progressTasksAtom.get().filter((t) => t.id !== id));
}

/**
 * Flash the task red for `flashMs`, then remove it. Useful for failures so
 * users see a brief "something went wrong" indicator even if a toast also
 * renders the same info.
 */
export function errorTask(id: string, flashMs = 1200): void {
    const tasks = progressTasksAtom.get();
    if (!tasks.some((t) => t.id === id)) return;
    progressTasksAtom.set(
        tasks.map((t) =>
            t.id === id ? { ...t, status: "error", progress: 1 } : t,
        ),
    );
    setTimeout(() => finishTask(id), flashMs);
}

/**
 * Run `fn` while a task is visible in the global progress bar. The callback
 * receives an `update` helper so the task can report phase/fraction changes
 * while in-flight. Errors auto-flash red and rethrow.
 */
export async function withTask<T>(
    label: string,
    fn: (update: (patch: UpdateTaskPatch) => void) => Promise<T>,
    opts?: { initialProgress?: number | null },
): Promise<T> {
    const id = startTask({
        label,
        progress: opts?.initialProgress ?? null,
    });
    try {
        const result = await fn((patch) => updateTask(id, patch));
        finishTask(id);
        return result;
    } catch (err) {
        errorTask(id);
        throw err;
    }
}
