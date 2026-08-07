import {
  dispatchSessionConfigSnapshots,
  readSessionExecutionConfigSnapshot,
  setSessionConfigSnapshotHandlers,
  type AcpSessionConfigSnapshotHandlers,
} from "@/shared/api/acpSessionConfigSnapshots";
import {
  observeSessionTargetModelSnapshot,
  observeSessionTargetReasoningSnapshot,
} from "@/features/chat/lib/sessionTargetCoordinator";

const chatHandlers: AcpSessionConfigSnapshotHandlers = {
  applyModelConfigSnapshot: (sessionId, snapshot, context) => {
    observeSessionTargetModelSnapshot({ sessionId, snapshot, context });
  },
  applyReasoningEffortConfigSnapshot: (sessionId, reasoningEffort, context) => {
    observeSessionTargetReasoningSnapshot({
      sessionId,
      reasoningEffort,
      context,
    });
  },
};

export function registerChatSessionConfigSnapshotHandlers(): void {
  setSessionConfigSnapshotHandlers(chatHandlers);
}

// The adapter owns wire parsing and context enrichment only. Admission,
// acknowledgement, and store commits belong to the session target coordinator.
export function applyChatSessionConfigOptionsSnapshot(
  sessionId: string,
  source: unknown,
  context: Parameters<typeof dispatchSessionConfigSnapshots>[3],
): void {
  const executionSnapshot = readSessionExecutionConfigSnapshot(source);
  const enrichedContext = executionSnapshot
    ? {
        ...context,
        providerId: context.providerId ?? executionSnapshot.providerId,
        modelId: context.modelId ?? executionSnapshot.modelId,
      }
    : context;
  dispatchSessionConfigSnapshots(
    sessionId,
    source,
    chatHandlers,
    enrichedContext,
  );
}
