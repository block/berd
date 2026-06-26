import {
  dispatchSessionConfigSnapshots,
  setSessionConfigSnapshotHandlers,
  type AcpModelConfigSnapshot,
  type AcpReasoningEffortConfigSnapshot,
  type AcpSessionConfigSnapshotContext,
  type AcpSessionConfigSnapshotHandlers,
} from "@/shared/api/acpSessionConfigSnapshots";
import {
  type ModelSelectionIntent,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import {
  logReasoningEffortInfo,
  reasoningEffortConfigLogFields,
  shortLogId,
} from "@/shared/lib/reasoningEffortDiagnostics";

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
  context: AcpSessionConfigSnapshotContext,
): void {
  dispatchSessionConfigSnapshots(sessionId, source, chatHandlers, context);
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
  context: AcpSessionConfigSnapshotContext,
): void {
  const sessionStore = useChatSessionStore.getState();
  const session = sessionStore.getSession(sessionId);
  const intent = sessionStore.getModelSelectionIntent(sessionId);

  // During an active model/provider switch the session's reasoningEffort is
  // cleared synchronously and will be re-populated by the response to the new
  // setModel/setProvider call. Accepting a stale notification here would flash
  // the old model's reasoning options before the new config arrives.
  if (intent && !reasoningEffortSnapshotMatchesIntent(intent, context)) {
    logReasoningEffortInfo("snapshot dropped stale", {
      sessionId: shortLogId(sessionId),
      sessionExists: Boolean(session),
      intentKind: intent.kind,
      origin: context.origin,
      providerId: context.providerId ?? null,
      modelId: context.modelId ?? null,
      ...reasoningEffortConfigLogFields("snapshot", reasoningEffort),
    });
    console.warn("Dropped stale ACP reasoningEffort config snapshot", {
      sessionId: sessionId.slice(0, 8),
      intentKind: intent.kind,
      origin: context.origin,
      providerId: context.providerId,
      modelId: context.modelId,
    });
    return;
  }

  logReasoningEffortInfo("snapshot accepted", {
    sessionId: shortLogId(sessionId),
    sessionExists: Boolean(session),
    intentKind: intent?.kind ?? null,
    origin: context.origin,
    providerId: context.providerId ?? null,
    modelId: context.modelId ?? null,
    ...reasoningEffortConfigLogFields("previous", session?.reasoningEffort),
    ...reasoningEffortConfigLogFields("snapshot", reasoningEffort),
  });
  sessionStore.patchSession(sessionId, {
    reasoningEffort,
  });
}

function reasoningEffortSnapshotMatchesIntent(
  intent: ModelSelectionIntent,
  context: AcpSessionConfigSnapshotContext,
): boolean {
  if (context.origin === "notification") {
    return false;
  }
  if (intent.kind === "provider") {
    return context.providerId === intent.providerId;
  }
  return context.modelId === intent.modelId;
}
