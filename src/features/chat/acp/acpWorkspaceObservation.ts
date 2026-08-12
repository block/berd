import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { attachSessionFolder } from "@/features/chat/lib/sessionFolderRegistration";
import { getPendingSessionWorkspaceActivation } from "@/features/chat/lib/sessionWorkspaceActivation";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { isSameWorkspacePath } from "@/features/chat/lib/workspaceAttachments";
import { getMultiWorkspaceEnabled } from "@/features/workspaces/multiWorkspacePreference";

const pendingExecutionByToolCall = new Map<
  string,
  { cwd?: string; isExecution: boolean; createsWorkspace: boolean }
>();

function reportsCreatedWorkspace(update: SessionUpdate): boolean {
  const title =
    "title" in update && typeof update.title === "string"
      ? update.title.toLowerCase()
      : "";
  const output =
    "rawOutput" in update &&
    update.rawOutput &&
    typeof update.rawOutput === "object" &&
    !Array.isArray(update.rawOutput)
      ? (update.rawOutput as Record<string, unknown>)
      : null;
  const operation =
    typeof output?.operation === "string" ? output.operation.toLowerCase() : "";
  return (
    /\b(create|mkdir|clone|init|worktree)\b/.test(title) ||
    /^(create|mkdir|clone|init|create_worktree)$/.test(operation)
  );
}

const observationsInFlightBySessionPath = new Map<string, Promise<void>>();

function registerObservedWorkspace(sessionId: string, path: string): void {
  const key = observationKey(sessionId, path);
  if (observationsInFlightBySessionPath.has(key)) return;
  const registration: Promise<void> = attachSessionFolder(sessionId, path)
    .then(() => undefined)
    .catch((error) => {
      console.info("[workspace-observer] ignored completed tool cwd", {
        sessionId: sessionId.slice(0, 8),
        error: String(error),
      });
    })
    .finally(() => {
      if (observationsInFlightBySessionPath.get(key) === registration) {
        observationsInFlightBySessionPath.delete(key);
      }
    });
  observationsInFlightBySessionPath.set(key, registration);
}

function observationKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}\u0000${toolCallId}`;
}

function structuredWorkspacePath(
  value: unknown,
  fields: readonly ("cwd" | "path")[],
): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const field of fields) {
    const candidate = record[field];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function explicitWorkspacePath(
  update: SessionUpdate,
  createsWorkspace: boolean,
): string | null {
  if (
    update.sessionUpdate !== "tool_call" &&
    update.sessionUpdate !== "tool_call_update"
  ) {
    return null;
  }
  if (update.status === "completed" && createsWorkspace) {
    const createdPath = structuredWorkspacePath(update.rawOutput, ["path"]);
    if (createdPath) return createdPath;
  }
  const inputCwd = structuredWorkspacePath(update.rawInput, ["cwd"]);
  if (inputCwd) return inputCwd;
  return update.status === "completed"
    ? structuredWorkspacePath(update.rawOutput, ["cwd"])
    : null;
}

/** Observe only structured execution context, never shell prose or unstructured output. */
export function observeWorkspaceToolCall(
  sessionId: string,
  update: SessionUpdate,
): void {
  if (!getMultiWorkspaceEnabled()) return;
  if (
    update.sessionUpdate !== "tool_call" &&
    update.sessionUpdate !== "tool_call_update"
  ) {
    return;
  }

  const key = observationKey(sessionId, update.toolCallId);
  const pending = pendingExecutionByToolCall.get(key) ?? {
    isExecution: false,
    createsWorkspace: false,
  };
  if (update.kind === "execute") pending.isExecution = true;
  pending.createsWorkspace ||= reportsCreatedWorkspace(update);
  const workspacePath = explicitWorkspacePath(update, pending.createsWorkspace);
  if (workspacePath) pending.cwd = workspacePath;
  pendingExecutionByToolCall.set(key, pending);

  if (update.status !== "completed" && update.status !== "failed") return;

  pendingExecutionByToolCall.delete(key);
  if (update.status !== "completed" || !pending.isExecution || !pending.cwd)
    return;
  const queuedActivation = getPendingSessionWorkspaceActivation(sessionId);
  const currentCwd = useChatSessionStore
    .getState()
    .getSession(sessionId)?.workingDir;
  if (
    queuedActivation &&
    currentCwd &&
    isSameWorkspacePath(pending.cwd, currentCwd) &&
    !isSameWorkspacePath(pending.cwd, queuedActivation.path)
  ) {
    return;
  }

  registerObservedWorkspace(sessionId, pending.cwd);
}

export function clearWorkspaceToolCallObservations(sessionId?: string): void {
  if (!sessionId) {
    pendingExecutionByToolCall.clear();
    return;
  }
  const prefix = `${sessionId}\u0000`;
  for (const key of pendingExecutionByToolCall.keys()) {
    if (key.startsWith(prefix)) pendingExecutionByToolCall.delete(key);
  }
}
