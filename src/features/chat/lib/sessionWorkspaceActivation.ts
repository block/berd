import { updateWorkingDir } from "@/shared/api/acpApi";
import { getGitState } from "@/shared/api/git";
import { checkDirectoriesExist } from "@/shared/api/pathResolver";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { isSessionRunning } from "@/features/chat/lib/sessionActivity";

const STORAGE_KEY = "goose:pending-session-workspace-activations";
const CHANGED_EVENT = "goose:pending-session-workspace-activations-changed";

export interface PendingSessionWorkspaceActivation {
  requestId: string;
  sessionId: string;
  path: string;
  branch: string | null;
  requestedAt: string;
}

type PendingBySession = Record<string, PendingSessionWorkspaceActivation>;

interface ApplyingSessionWorkspaceActivation {
  promise: Promise<string | null>;
  allowRunning: boolean;
}

const applyingBySession = new Map<string, ApplyingSessionWorkspaceActivation>();
const intentGenerationBySession = new Map<string, number>();

export class SessionWorkspaceActivationError extends Error {
  readonly attemptedRequestId: string;

  constructor(cause: unknown, attemptedRequestId: string) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "SessionWorkspaceActivationError";
    this.attemptedRequestId = attemptedRequestId;
  }
}

/**
 * Claims the latest cwd intent for a session. Older lifecycle operations use
 * the returned generation as a compare-and-set guard before queueing work.
 */
export function getSessionWorkspaceIntentGeneration(sessionId: string): number {
  return intentGenerationBySession.get(sessionId) ?? 0;
}

export function claimSessionWorkspaceIntent(sessionId: string): number {
  const generation = (intentGenerationBySession.get(sessionId) ?? 0) + 1;
  intentGenerationBySession.set(sessionId, generation);
  return generation;
}

export function isCurrentSessionWorkspaceIntent(
  sessionId: string,
  generation: number,
): boolean {
  return intentGenerationBySession.get(sessionId) === generation;
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage ?? null;
}

function isPendingActivation(
  value: unknown,
): value is PendingSessionWorkspaceActivation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<PendingSessionWorkspaceActivation>;
  return (
    typeof record.requestId === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.path === "string" &&
    (typeof record.branch === "string" || record.branch === null) &&
    typeof record.requestedAt === "string"
  );
}

function readPending(): PendingBySession {
  const storage = getStorage();
  if (!storage) return {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([sessionId, value]) =>
          isPendingActivation(value) && value.sessionId === sessionId,
      ),
    );
  } catch {
    return {};
  }
}

function writePending(pending: PendingBySession): void {
  const storage = getStorage();
  if (!storage) {
    throw new Error("Workspace activation storage is unavailable.");
  }
  if (Object.keys(pending).length === 0) {
    storage.removeItem(STORAGE_KEY);
  } else {
    storage.setItem(STORAGE_KEY, JSON.stringify(pending));
  }
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

export function listPendingSessionWorkspaceActivations(): PendingSessionWorkspaceActivation[] {
  return Object.values(readPending());
}

export function getPendingSessionWorkspaceActivation(
  sessionId: string,
): PendingSessionWorkspaceActivation | null {
  return readPending()[sessionId] ?? null;
}

export function queueSessionWorkspaceActivation(input: {
  sessionId: string;
  path: string;
  branch: string | null;
  intentGeneration?: number;
}): PendingSessionWorkspaceActivation {
  if (
    input.intentGeneration != null &&
    !isCurrentSessionWorkspaceIntent(input.sessionId, input.intentGeneration)
  ) {
    throw new Error(
      "A newer session workspace intent superseded this request.",
    );
  }
  if (input.intentGeneration == null) {
    claimSessionWorkspaceIntent(input.sessionId);
  }
  const activation: PendingSessionWorkspaceActivation = {
    requestId: crypto.randomUUID(),
    sessionId: input.sessionId,
    path: input.path,
    branch: input.branch,
    requestedAt: new Date().toISOString(),
  };
  writePending({ ...readPending(), [input.sessionId]: activation });
  return activation;
}

function clearIfCurrent(activation: PendingSessionWorkspaceActivation): void {
  const pending = readPending();
  if (pending[activation.sessionId]?.requestId !== activation.requestId) return;
  delete pending[activation.sessionId];
  writePending(pending);
}

/**
 * Cancel queued intent and wait for any older backend update to settle. Callers
 * can then apply a newer explicit workspace without the older request winning.
 */
export function clearPendingSessionWorkspaceActivation(
  sessionId: string,
): void {
  const pending = readPending();
  if (!pending[sessionId]) return;
  delete pending[sessionId];
  writePending(pending);
}

export async function supersedePendingSessionWorkspaceActivation(
  sessionId: string,
  intentGeneration?: number,
): Promise<void> {
  if (intentGeneration == null) {
    claimSessionWorkspaceIntent(sessionId);
  } else if (!isCurrentSessionWorkspaceIntent(sessionId, intentGeneration)) {
    throw new Error(
      "A newer session workspace intent superseded this request.",
    );
  }
  clearPendingSessionWorkspaceActivation(sessionId);
  await applyingBySession.get(sessionId)?.promise.catch(() => undefined);
  if (
    intentGeneration != null &&
    !isCurrentSessionWorkspaceIntent(sessionId, intentGeneration)
  ) {
    throw new Error(
      "A newer session workspace intent superseded this request.",
    );
  }
}

export function subscribeToPendingSessionWorkspaceActivations(
  listener: () => void,
): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener(CHANGED_EVENT, listener);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(CHANGED_EVENT, listener);
    window.removeEventListener("storage", handleStorage);
  };
}

/**
 * Commit a requested workspace before the session's next operation begins.
 * Concurrent callers share one mutation, so idle drains and prompt preparation
 * cannot race each other.
 */
export function applyPendingSessionWorkspaceActivation(
  sessionId: string,
  options: { allowRunning?: boolean } = {},
): Promise<string | null> {
  const existing = applyingBySession.get(sessionId);
  if (existing) {
    // A prompt barrier may join an activation first claimed by the idle drain
    // after the prompt has entered its running state. Upgrade the shared
    // operation rather than rejecting the prompt's own cwd transition.
    if (options.allowRunning) existing.allowRunning = true;
    return existing.promise;
  }

  const activation = getPendingSessionWorkspaceActivation(sessionId);
  if (!activation) return Promise.resolve(null);

  const operation: ApplyingSessionWorkspaceActivation = {
    promise: Promise.resolve(null),
    allowRunning: options.allowRunning === true,
  };
  const applying = (async () => {
    let next: PendingSessionWorkspaceActivation | null = activation;
    while (next) {
      const attempted: PendingSessionWorkspaceActivation = next;
      try {
        // Failures intentionally leave the request persisted: the chat must not
        // silently continue from its old folder after Berd accepted the switch.
        const missing = await checkDirectoriesExist([attempted.path]);
        if (missing.length > 0) {
          // Keep the request persisted so prompt barriers remain closed until the
          // user supplies a valid replacement or explicitly supersedes it.
          throw new Error(
            `No directory at "${attempted.path}". The pending switch still needs a valid replacement.`,
          );
        }

        let branch = attempted.branch;
        try {
          const gitState = await getGitState(attempted.path);
          branch = gitState.isGitRepo ? gitState.currentBranch : null;
        } catch {
          // Branch is display metadata; the validated folder is still usable.
        }

        await updateWorkingDir(sessionId, attempted.path, () => {
          if (operation.allowRunning) return;
          const runtime = useChatStore.getState().getSessionRuntime(sessionId);
          if (
            isSessionRunning(runtime.chatState) ||
            runtime.isRunCancellationPending
          ) {
            throw new Error(
              "The session started running before its pending workspace switch could be applied.",
            );
          }
        });
        // Reflect the backend mutation even when a caller cleared/replaced the
        // persisted request while updateWorkingDir was in flight. Newer intent
        // may immediately supersede this, but renderer state must never claim a
        // different cwd from the backend in the interim.
        useChatSessionStore
          .getState()
          .patchSession(sessionId, { workingDir: attempted.path });
        const current = getPendingSessionWorkspaceActivation(sessionId);
        if (current?.requestId !== attempted.requestId) {
          // A newer request arrived while this update was in flight. Keep the
          // barrier closed and apply the latest request before any prompt runs.
          next = current;
          continue;
        }

        const store = useChatSessionStore.getState();
        store.setActiveWorkspace(sessionId, { path: attempted.path, branch });
        clearIfCurrent(attempted);
        return attempted.path;
      } catch (error) {
        throw new SessionWorkspaceActivationError(error, attempted.requestId);
      }
    }
    return null;
  })().finally(() => {
    if (applyingBySession.get(sessionId) === operation) {
      applyingBySession.delete(sessionId);
    }
  });

  operation.promise = applying;
  applyingBySession.set(sessionId, operation);
  return applying;
}

export function hasPendingSessionWorkspaceActivation(
  sessionId: string,
): boolean {
  return getPendingSessionWorkspaceActivation(sessionId) !== null;
}
