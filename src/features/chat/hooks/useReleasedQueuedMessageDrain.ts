import { useEffect } from "react";
import { i18n } from "@/shared/i18n";

import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { sendQueuedPromptToExistingSessionInBackground } from "@/features/chat/lib/queuedSessionSend";

const drainingSessionIds = new Set<string>();

function drainReleasedQueuedMessage(sessionId: string): void {
  if (drainingSessionIds.has(sessionId)) {
    return;
  }

  const chatStore = useChatStore.getState();
  const queuedMessage = chatStore.queuedMessageBySession[sessionId]?.[0];
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
        useChatStore.getState().queuedMessageBySession[sessionId]?.[0] !==
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
        useChatStore.getState().queuedMessageBySession[sessionId]?.[0] ===
        queuedMessage
      ) {
        useChatStore
          .getState()
          .dismissQueuedMessage(sessionId, queuedMessage.recordId);
      }
    })
    .catch((error) => {
      const message = i18n.t("chat:queue.releasedSendFailed");
      console.error(
        `[released-queue] failed to send queued prompt for session ${sessionId}`,
        error,
      );
      const current =
        useChatStore.getState().queuedMessageBySession[sessionId]?.[0];
      if (current === queuedMessage) {
        useChatStore
          .getState()
          .deferTransportReadyMessage(sessionId, queuedMessage.recordId, {
            type: "workspace-first-send",
            status: "failed",
            error: message,
          });
      }
    })
    .finally(() => {
      drainingSessionIds.delete(sessionId);
    });
}

function getOwnedSessionIds(
  queuedMessageBySession: Record<string, unknown>,
  scopedSessionId?: string,
): string[] {
  if (scopedSessionId) return [scopedSessionId];
  const sessionWindowStore = useSessionWindowStore.getState();
  if (!sessionWindowStore.hasLoadedSnapshot) return [];
  return Object.keys(queuedMessageBySession).filter(
    (sessionId) => !sessionWindowStore.isOpenInWindow(sessionId),
  );
}

function drainReadyReleasedMessages(scopedSessionId?: string): void {
  const { queuedMessageBySession } = useChatStore.getState();
  for (const sessionId of getOwnedSessionIds(
    queuedMessageBySession,
    scopedSessionId,
  )) {
    drainReleasedQueuedMessage(sessionId);
  }
}

export function useReleasedQueuedMessageDrain(
  scopedSessionId?: string,
  ownerReady = true,
): void {
  useEffect(() => {
    if (!ownerReady) return;
    drainReadyReleasedMessages(scopedSessionId);
    const unsubscribeWindowStore = scopedSessionId
      ? undefined
      : useSessionWindowStore.subscribe((state, previousState) => {
          if (
            state.hasLoadedSnapshot &&
            (!previousState.hasLoadedSnapshot ||
              state.openSessions !== previousState.openSessions)
          ) {
            drainReadyReleasedMessages();
          }
        });
    const unsubscribeChatStore = useChatStore.subscribe(
      (state, previousState) => {
        for (const sessionId of getOwnedSessionIds(
          state.queuedMessageBySession,
          scopedSessionId,
        )) {
          const queuedMessage = state.queuedMessageBySession[sessionId]?.[0];
          if (
            queuedMessage?.kind !== "transport-ready" ||
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
            previousState.queuedMessageBySession[sessionId]?.[0] !==
            queuedMessage;
          if (
            currentChatState === "idle" &&
            !currentBlocked &&
            (previousBlocked || becameTransportReady)
          ) {
            drainReleasedQueuedMessage(sessionId);
          }
        }
      },
    );
    return () => {
      unsubscribeWindowStore?.();
      unsubscribeChatStore();
    };
  }, [ownerReady, scopedSessionId]);
}
