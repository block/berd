import {
  dispatchSessionConfigSnapshots,
  setSessionConfigSnapshotHandlers,
  type AcpModelConfigSnapshot,
  type AcpReasoningEffortConfigSnapshot,
  type AcpSessionConfigSnapshotHandlers,
} from "@/shared/api/acpSessionConfigSnapshots";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";

const chatHandlers: AcpSessionConfigSnapshotHandlers = {
  applyModelConfigSnapshot: handleModelConfigSnapshot,
  applyReasoningEffortConfigSnapshot: handleReasoningEffortConfigSnapshot,
};

export function registerChatSessionConfigSnapshotHandlers(): void {
  setSessionConfigSnapshotHandlers(chatHandlers);
}

// The notification handler lives in this feature, so it dispatches directly
// against the chat handlers rather than the startup-registered registry the
// shared `acpApi` path uses. Both share `dispatchSessionConfigSnapshots`.
export function applyChatSessionConfigOptionsSnapshot(
  sessionId: string,
  source: unknown,
): void {
  dispatchSessionConfigSnapshots(sessionId, source, chatHandlers);
}

function handleModelConfigSnapshot(
  sessionId: string,
  snapshot: AcpModelConfigSnapshot,
): void {
  const sessionStore = useChatSessionStore.getState();
  const session = sessionStore.getSession(sessionId);
  const intent = sessionStore.getModelSelectionIntent(sessionId);
  const localModelId = session?.modelId;
  const snapshotMatchesLocalModel = localModelId === snapshot.modelId;
  const snapshotMatchesPendingIntent =
    intent?.kind === "model" && intent.modelId === snapshot.modelId;

  // Backend config snapshots can arrive out of order around a user-triggered
  // model switch. Once the UI has a local model, only accept snapshots that
  // confirm the local state or the active intent; otherwise a stale snapshot can
  // flip the picker back and re-trigger preference/bootstrap churn.
  if (
    snapshotMatchesLocalModel ||
    snapshotMatchesPendingIntent ||
    (!localModelId && !intent)
  ) {
    sessionStore.patchSession(sessionId, {
      modelId: snapshot.modelId,
      modelName: snapshot.modelName,
    });
    return;
  }

  console.warn("Dropped divergent ACP model config snapshot", {
    sessionId: sessionId.slice(0, 8),
    localModelId,
    snapshotModelId: snapshot.modelId,
    intentKind: intent?.kind,
    intentModelId: intent?.modelId,
  });
}

function handleReasoningEffortConfigSnapshot(
  sessionId: string,
  reasoningEffort: AcpReasoningEffortConfigSnapshot,
): void {
  useChatSessionStore.getState().patchSession(sessionId, {
    reasoningEffort,
  });
}
