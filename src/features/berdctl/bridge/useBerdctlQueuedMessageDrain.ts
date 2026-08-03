import { useEffect } from "react";

import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { loadPersistedMessageQueues } from "@/features/chat/stores/queuePersistence";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import {
  isBerdctlCrossSessionQueuedMessage,
  sendPromptToExistingSessionInBackground,
} from "@/features/berdctl/commands/runtime/sessionSend";

const drainingSessionIds = new Set<string>();
let ownershipRefreshSequence = 0;

async function refreshReclaimedQueues(
  previousOpenSessions: Record<string, string>,
  openSessions: Record<string, string>,
): Promise<void> {
  const reclaimedSessionIds = Object.keys(previousOpenSessions).filter(
    (sessionId) => !(sessionId in openSessions),
  );
  if (reclaimedSessionIds.length === 0) {
    drainReadyQueuedMessages();
    return;
  }
  const sequence = ++ownershipRefreshSequence;
  const persistedQueues = await loadPersistedMessageQueues();
  if (sequence !== ownershipRefreshSequence) return;
  useChatStore
    .getState()
    .reconcileQueuedMessages(persistedQueues, reclaimedSessionIds);
  drainReadyQueuedMessages();
}

function drainQueuedMessage(queuedSessionId: string): void {
  if (drainingSessionIds.has(queuedSessionId)) {
    return;
  }

  const chatStore = useChatStore.getState();
  const queuedMessage = chatStore.queuedMessageBySession[queuedSessionId]?.[0];
  const runtime = chatStore.getSessionRuntime(queuedSessionId);
  if (
    queuedMessage?.kind !== "transport-ready" ||
    queuedMessage.editing ||
    !isBerdctlCrossSessionQueuedMessage(queuedMessage) ||
    queuedMessage.releasedFromDeferred ||
    isSessionRunning(runtime.chatState) ||
    runtime.isRunCancellationPending
  ) {
    return;
  }

  drainingSessionIds.add(queuedSessionId);
  const send = sendPromptToExistingSessionInBackground(
    queuedSessionId,
    queuedMessage.payload.text,
    () => {
      const latestQueuedMessage =
        useChatStore.getState().queuedMessageBySession[queuedSessionId]?.[0];
      if (
        latestQueuedMessage?.recordId !== queuedMessage.recordId ||
        latestQueuedMessage.payload !== queuedMessage.payload ||
        latestQueuedMessage.editing
      ) {
        throw new DOMException("The queued prompt was canceled.", "AbortError");
      }
    },
  );
  let sendSucceeded = false;
  void send
    .then(() => {
      sendSucceeded = true;
      const latestQueuedMessage =
        useChatStore.getState().queuedMessageBySession[queuedSessionId]?.[0];
      if (
        latestQueuedMessage?.recordId === queuedMessage.recordId &&
        latestQueuedMessage.payload === queuedMessage.payload &&
        !latestQueuedMessage.editing
      ) {
        useChatStore
          .getState()
          .dismissQueuedMessage(queuedSessionId, queuedMessage.recordId);
      }
    })
    .catch((error) => {
      console.error(
        `[berdctl-queue] failed to send queued prompt for session ${queuedSessionId}`,
        error,
      );
    })
    .finally(() => {
      drainingSessionIds.delete(queuedSessionId);
      if (sendSucceeded) drainQueuedMessage(queuedSessionId);
    });
}

function getQueuedSessionIds(
  queuedMessageBySession: Record<string, unknown>,
  queuedSessionId?: string,
): string[] {
  const chatStore = useChatStore.getState();
  if (!chatStore.hasHydratedMessageQueues) return [];
  if (!useChatSessionStore.getState().hasHydratedSessions) return [];
  if (queuedSessionId) return [queuedSessionId];
  const sessionWindowStore = useSessionWindowStore.getState();
  if (!sessionWindowStore.hasLoadedSnapshot) return [];
  return Object.keys(queuedMessageBySession).filter(
    (sessionId) => !sessionWindowStore.isOpenInWindow(sessionId),
  );
}

function drainReadyQueuedMessages(scopedSessionId?: string): void {
  const { queuedMessageBySession } = useChatStore.getState();
  for (const queuedSessionId of getQueuedSessionIds(
    queuedMessageBySession,
    scopedSessionId,
  )) {
    drainQueuedMessage(queuedSessionId);
  }
}

export function useBerdctlQueuedMessageDrain(
  queuedSessionId?: string,
  ownerReady = true,
): void {
  useEffect(() => {
    if (!ownerReady) return;
    drainReadyQueuedMessages(queuedSessionId);
    const unsubscribeWindowStore = queuedSessionId
      ? undefined
      : useSessionWindowStore.subscribe((state, previousState) => {
          if (
            state.hasLoadedSnapshot &&
            (!previousState.hasLoadedSnapshot ||
              state.openSessions !== previousState.openSessions)
          ) {
            if (!previousState.hasLoadedSnapshot) {
              drainReadyQueuedMessages();
            } else {
              void refreshReclaimedQueues(
                previousState.openSessions,
                state.openSessions,
              );
            }
          }
        });
    const unsubscribeSessionStore = useChatSessionStore.subscribe(
      (state, previousState) => {
        if (state.hasHydratedSessions && !previousState.hasHydratedSessions) {
          drainReadyQueuedMessages(queuedSessionId);
        }
      },
    );
    const unsubscribeChatStore = useChatStore.subscribe(
      (state, previousState) => {
        if (
          state.hasHydratedMessageQueues &&
          !previousState.hasHydratedMessageQueues
        ) {
          drainReadyQueuedMessages(queuedSessionId);
          return;
        }
        const queuedSessionIds = getQueuedSessionIds(
          state.queuedMessageBySession,
          queuedSessionId,
        );
        for (const queuedSessionId of queuedSessionIds) {
          const queuedMessage =
            state.queuedMessageBySession[queuedSessionId]?.[0];
          if (
            !queuedMessage ||
            queuedMessage.kind !== "transport-ready" ||
            queuedMessage.editing ||
            !isBerdctlCrossSessionQueuedMessage(queuedMessage) ||
            queuedMessage.releasedFromDeferred
          ) {
            continue;
          }

          const currentRuntime = state.sessionStateById[queuedSessionId];
          const previousRuntime =
            previousState.sessionStateById[queuedSessionId];
          const currentChatState = currentRuntime?.chatState ?? "idle";
          const currentBlocked =
            isSessionRunning(currentChatState) ||
            (currentRuntime?.isRunCancellationPending ?? false);
          const previousBlocked =
            isSessionRunning(previousRuntime?.chatState ?? "idle") ||
            (previousRuntime?.isRunCancellationPending ?? false);
          // Match the composer queue: failed/cancelling runs leave the prompt
          // parked until every blocking runtime signal clears.
          const previousQueuedMessage =
            previousState.queuedMessageBySession[queuedSessionId]?.[0];
          const becameTransportReady =
            previousQueuedMessage?.kind !== "transport-ready" ||
            previousQueuedMessage.recordId !== queuedMessage.recordId;
          const becameReadyAfterEditing =
            previousQueuedMessage?.recordId === queuedMessage.recordId &&
            previousQueuedMessage.editing === true &&
            !queuedMessage.editing;
          if (
            currentChatState === "idle" &&
            !currentBlocked &&
            (previousBlocked || becameTransportReady || becameReadyAfterEditing)
          ) {
            drainQueuedMessage(queuedSessionId);
          }
        }
      },
    );
    return () => {
      unsubscribeWindowStore?.();
      unsubscribeSessionStore();
      unsubscribeChatStore();
    };
  }, [ownerReady, queuedSessionId]);
}
