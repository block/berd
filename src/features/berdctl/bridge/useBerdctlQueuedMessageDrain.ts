import { useEffect } from "react";

import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  isBerdctlCrossSessionQueuedMessage,
  sendPromptToExistingSessionInBackground,
} from "@/features/berdctl/commands/runtime/sessionSend";

const drainingSessionIds = new Set<string>();

function drainQueuedMessage(sessionId: string): void {
  if (drainingSessionIds.has(sessionId)) {
    return;
  }

  const chatStore = useChatStore.getState();
  const queuedMessage = chatStore.queuedMessageBySession[sessionId];
  const runtime = chatStore.getSessionRuntime(sessionId);
  if (
    !isBerdctlCrossSessionQueuedMessage(queuedMessage) ||
    isSessionRunning(runtime.chatState)
  ) {
    return;
  }

  drainingSessionIds.add(sessionId);
  void sendPromptToExistingSessionInBackground(sessionId, queuedMessage.text)
    .then(() => {
      if (
        useChatStore.getState().queuedMessageBySession[sessionId] ===
        queuedMessage
      ) {
        useChatStore.getState().dismissQueuedMessage(sessionId);
      }
    })
    .catch((error) => {
      console.error(
        `[berdctl-queue] failed to send queued prompt for session ${sessionId}`,
        error,
      );
    })
    .finally(() => {
      drainingSessionIds.delete(sessionId);
    });
}

function drainReadyQueuedMessages(): void {
  const { queuedMessageBySession } = useChatStore.getState();
  for (const sessionId of Object.keys(queuedMessageBySession)) {
    drainQueuedMessage(sessionId);
  }
}

export function useBerdctlQueuedMessageDrain(): void {
  useEffect(() => {
    drainReadyQueuedMessages();
    return useChatStore.subscribe((state, previousState) => {
      for (const sessionId of Object.keys(state.queuedMessageBySession)) {
        const queuedMessage = state.queuedMessageBySession[sessionId];
        if (!isBerdctlCrossSessionQueuedMessage(queuedMessage)) {
          continue;
        }

        const currentChatState = state.sessionStateById[sessionId]?.chatState;
        const previousChatState =
          previousState.sessionStateById[sessionId]?.chatState;
        // Match the composer queue: a failed run leaves the queued prompt
        // parked until a later idle transition or bridge remount catch-up.
        if (currentChatState === "idle" && previousChatState !== "idle") {
          drainQueuedMessage(sessionId);
        }
      }
    });
  }, []);
}
