import {
  STARTER_TASKS,
  type StarterTaskCompletionState,
  type StarterTaskId,
} from "./starterTasks";

export const STARTER_TASK_PROGRESS_STORAGE_KEY =
  "goose:onboarding:starter-task-progress";
const VERSION = 1;

interface StoredStarterTaskProgress {
  version: typeof VERSION;
  completion: StarterTaskCompletionState;
  awaiting: StarterTaskId[];
}

export interface StarterTaskProgress {
  completion: StarterTaskCompletionState;
  awaiting: Set<StarterTaskId>;
}

export const EMPTY_STARTER_TASK_COMPLETION: StarterTaskCompletionState = {
  "connect-provider": false,
  "start-chat": false,
  "create-project": false,
  "add-widget": false,
};

const taskIds = new Set<StarterTaskId>(STARTER_TASKS.map((task) => task.id));

export function loadStarterTaskProgress(): StarterTaskProgress {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(STARTER_TASK_PROGRESS_STORAGE_KEY) ?? "null",
    );
    if (!parsed || typeof parsed !== "object") throw new Error("missing");
    const stored = parsed as Partial<StoredStarterTaskProgress>;
    if (stored.version !== VERSION || !stored.completion)
      throw new Error("invalid");
    return {
      completion: {
        ...EMPTY_STARTER_TASK_COMPLETION,
        ...Object.fromEntries(
          Object.entries(stored.completion).filter(
            ([id, value]) =>
              taskIds.has(id as StarterTaskId) && typeof value === "boolean",
          ),
        ),
      },
      awaiting: new Set(
        (stored.awaiting ?? []).filter((id): id is StarterTaskId =>
          taskIds.has(id),
        ),
      ),
    };
  } catch {
    return {
      completion: { ...EMPTY_STARTER_TASK_COMPLETION },
      awaiting: new Set(),
    };
  }
}

export function saveStarterTaskProgress(progress: StarterTaskProgress): void {
  try {
    localStorage.setItem(
      STARTER_TASK_PROGRESS_STORAGE_KEY,
      JSON.stringify({
        version: VERSION,
        completion: progress.completion,
        awaiting: [...progress.awaiting],
      } satisfies StoredStarterTaskProgress),
    );
  } catch {
    // Progress remains available for this app session when storage is unavailable.
  }
}

export function persistStarterTaskCompletion(taskId: StarterTaskId): void {
  const progress = loadStarterTaskProgress();
  progress.completion[taskId] = true;
  progress.awaiting.delete(taskId);
  saveStarterTaskProgress(progress);
}

export function clearStarterTaskProgress(): void {
  try {
    localStorage.removeItem(STARTER_TASK_PROGRESS_STORAGE_KEY);
  } catch {
    // Reset still applies to in-memory progress when storage is unavailable.
  }
}
