import { useEffect } from "react";

import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { sendQueuedPromptToExistingSessionInBackground } from "@/features/chat/lib/queuedSessionSend";

const drainingSessionIds = new Set<string>();

function drainReleasedQueuedMessage(sessionId: string): void {
  if (drainingSessionIds.has(sessionId)) {
    return;
  }

  const chatStore = useChatStore.getState();
  const queuedMessage = chatStore.queuedMessageBySession[sessionId];
  const runtime = chatStore.getSessionRuntime(sessionId);
  if (
    queuedMessage?.kind !== "transport-ready" ||
    !queuedMessage.releasedFromDeferred ||
    isSessionRunning(runtime.chatState) ||
    runtime.isRunCancellationPending
  ) {
    return;
  }

  drainingSessionIds.add(sessionId);
  void sendQueuedPromptToExistingSessionInBackground(
    sessionId,
    queuedMessage,
    () => {
      if (
        useChatStore.getState().queuedMessageBySession[sessionId] !==
        queuedMessage
      ) {
        throw new DOMException("The queued prompt was canceled.", "AbortError");
      }
    },
    () => {
      useChatStore
        .getState()
        .dismissQueuedMessage(sessionId, queuedMessage.recordId);
    },
  )
    .then(() => {
      if (
        useChatStore.getState().queuedMessageBySession[sessionId] ===
        queuedMessage
      ) {
        useChatStore
          .getState()
          .dismissQueuedMessage(sessionId, queuedMessage.recordId);
      }
    })
    .catch((error) => {
      console.error(
        `[released-queue] failed to send queued prompt for session ${sessionId}`,
        error,
      );
    })
    .finally(() => {
      drainingSessionIds.delete(sessionId);
    });
}

function drainReadyReleasedMessages(): void {
  const { queuedMessageBySession } = useChatStore.getState();
  for (const sessionId of Object.keys(queuedMessageBySession)) {
    drainReleasedQueuedMessage(sessionId);
  }
}

export function useReleasedQueuedMessageDrain(): void {
  useEffect(() => {
    drainReadyReleasedMessages();
    return useChatStore.subscribe((state, previousState) => {
      for (const sessionId of Object.keys(state.queuedMessageBySession)) {
        const queuedMessage = state.queuedMessageBySession[sessionId];
        if (
          queuedMessage.kind !== "transport-ready" ||
          !queuedMessage.releasedFromDeferred
        ) {
          continue;
        }

        const currentRuntime = state.sessionStateById[sessionId];
        const previousRuntime = previousState.sessionStateById[sessionId];
        const currentChatState = currentRuntime?.chatState ?? "idle";
        const currentBlocked =
          isSessionRunning(currentChatState) ||
          (currentRuntime?.isRunCancellationPending ?? false);
        const previousBlocked =
          isSessionRunning(previousRuntime?.chatState ?? "idle") ||
          (previousRuntime?.isRunCancellationPending ?? false);
        const becameTransportReady =
          previousState.queuedMessageBySession[sessionId] !== queuedMessage;
        if (
          currentChatState === "idle" &&
          !currentBlocked &&
          (previousBlocked || becameTransportReady)
        ) {
          drainReleasedQueuedMessage(sessionId);
        }
      }
    });
  }, []);
}
