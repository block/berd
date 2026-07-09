import { useEffect, useCallback, useMemo, useRef } from "react";
import type { ChatState } from "@/shared/types/chat";
import { isPromiseLike } from "@/shared/lib/isPromiseLike";
import type { ChatAttachmentDraft } from "@/shared/types/messages";
import { useChatStore } from "../stores/chatStore";
import type { ChatSendOptions } from "../types";

const MAX_CONSECUTIVE_SEND_FAILURES = 2;

type QueuedMessage = {
  text: string;
  personaId?: string;
  attachments?: ChatAttachmentDraft[];
  sendOptions?: ChatSendOptions;
};

function getQueuedMessageKey(
  queuedMessage: QueuedMessage | null,
): string | null {
  if (!queuedMessage) {
    return null;
  }

  return JSON.stringify({
    text: queuedMessage.text,
    personaId: queuedMessage.personaId ?? null,
    sendOptions: queuedMessage.sendOptions ?? null,
    attachments:
      queuedMessage.attachments?.map((attachment) => ({
        id: attachment.id,
        kind: attachment.kind,
        name: attachment.name,
        path: "path" in attachment ? (attachment.path ?? null) : null,
      })) ?? [],
  });
}

function isBerdctlCrossSessionQueuedMessage(
  queuedMessage: Pick<QueuedMessage, "sendOptions"> | null,
): boolean {
  return (
    queuedMessage?.sendOptions?.userMessageMetadata?.origin ===
    "berdctl_cross_session"
  );
}

function isRuntimeSendBlocked(
  runtime:
    | {
        activeRunId: string | null;
        isRunCancellationPending: boolean;
      }
    | undefined,
) {
  return (
    (runtime?.activeRunId ?? null) !== null ||
    (runtime?.isRunCancellationPending ?? false)
  );
}

/**
 * Single-slot message queue that holds one pending message while the agent is
 * busy and auto-sends it when the chat transitions back to idle.
 *
 * State lives in the Zustand store (keyed by session) so it survives tab
 * switches — users can queue a follow-up, navigate away, and come back to
 * find it sent.
 *
 * A direct Zustand store subscription ensures the drain fires even when the
 * webview is backgrounded and React defers re-renders (e.g. rAF paused,
 * visibility-hidden throttling). The subscription detects ready-to-send
 * transitions synchronously and invokes the drain without waiting for the next
 * paint frame.
 */
export function useMessageQueue(
  sessionId: string,
  chatState: ChatState,
  sendMessage: (
    text: string,
    overridePersona?: { id: string; name?: string },
    attachments?: ChatAttachmentDraft[],
    sendOptions?: ChatSendOptions,
  ) => boolean | Promise<boolean>,
  readOnly = false,
  isSendBlocked = false,
) {
  const queuedMessage = useChatStore(
    (s) => s.queuedMessageBySession[sessionId] ?? null,
  );
  const previousChatStateRef = useRef(chatState);
  const idleCycleRef = useRef(0);
  const lastAttemptRef = useRef<{
    key: string;
    idleCycle: number;
  } | null>(null);
  const failureStateRef = useRef<{
    key: string;
    count: number;
  } | null>(null);
  const inFlightAttemptKeyRef = useRef<string | null>(null);
  const suppressNextRenderIdleCycleRef = useRef(false);
  const queuedMessageKey = useMemo(
    () => getQueuedMessageKey(queuedMessage),
    [queuedMessage],
  );

  // --- Background-safe store subscription ---
  // When the webview is hidden/minimized, React may not schedule re-renders
  // for Zustand selector updates because requestAnimationFrame is paused.
  // This direct store subscription fires synchronously on state changes and
  // triggers the queued message send immediately, bypassing React's render
  // cycle. Uses a ref to always call the latest sendMessage callback.
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  const tryDrainQueuedMessage = useCallback(
    (queuedMsg: QueuedMessage | null | undefined) => {
      if (
        readOnlyRef.current ||
        !queuedMsg ||
        isBerdctlCrossSessionQueuedMessage(queuedMsg)
      ) {
        return false;
      }

      const key = getQueuedMessageKey(queuedMsg);
      if (!key) {
        return false;
      }

      const hasReachedRetryLimit =
        failureStateRef.current?.key === key &&
        failureStateRef.current.count >= MAX_CONSECUTIVE_SEND_FAILURES;
      const alreadyAttemptedThisIdleCycle =
        lastAttemptRef.current?.key === key &&
        lastAttemptRef.current.idleCycle === idleCycleRef.current;
      const alreadySending = inFlightAttemptKeyRef.current === key;
      if (
        hasReachedRetryLimit ||
        alreadyAttemptedThisIdleCycle ||
        alreadySending
      ) {
        return false;
      }

      lastAttemptRef.current = {
        key,
        idleCycle: idleCycleRef.current,
      };
      inFlightAttemptKeyRef.current = key;

      const { text, personaId, attachments, sendOptions } = queuedMsg;
      const sendFn = sendMessageRef.current;
      const sendResult = sendOptions
        ? sendFn(
            text,
            personaId ? { id: personaId } : undefined,
            attachments,
            sendOptions,
          )
        : sendFn(text, personaId ? { id: personaId } : undefined, attachments);

      const finalize = (accepted: boolean | undefined) => {
        if (inFlightAttemptKeyRef.current === key) {
          inFlightAttemptKeyRef.current = null;
        }

        const latestQueuedMessage =
          useChatStore.getState().queuedMessageBySession[sessionId] ?? null;
        if (getQueuedMessageKey(latestQueuedMessage) !== key) {
          return;
        }

        if (accepted === false) {
          const previousFailureCount =
            failureStateRef.current?.key === key
              ? failureStateRef.current.count
              : 0;
          failureStateRef.current = {
            key,
            count: previousFailureCount + 1,
          };
          return;
        }

        failureStateRef.current = null;
        lastAttemptRef.current = null;
        useChatStore.getState().dismissQueuedMessage(sessionId);
      };

      if (isPromiseLike<boolean>(sendResult)) {
        void sendResult
          .then((accepted) => finalize(accepted))
          .catch(() => finalize(false));
      } else {
        finalize(sendResult);
      }

      return true;
    },
    [sessionId],
  );

  useEffect(() => {
    return useChatStore.subscribe((state, previousState) => {
      const runtime = state.sessionStateById[sessionId];
      const previousRuntime = previousState.sessionStateById[sessionId];
      const currentChatState = runtime?.chatState ?? "idle";
      const prevChatState = previousRuntime?.chatState ?? "idle";
      const isLiveSendBlocked = isRuntimeSendBlocked(runtime);
      const wasSendBlocked = isRuntimeSendBlocked(previousRuntime);
      const becameIdle =
        currentChatState === "idle" && prevChatState !== "idle";
      const becameReadyWhileIdle =
        currentChatState === "idle" && wasSendBlocked && !isLiveSendBlocked;

      if (becameIdle) {
        idleCycleRef.current += 1;
        suppressNextRenderIdleCycleRef.current = true;
      }

      if (!becameIdle && !becameReadyWhileIdle) {
        return;
      }

      if (currentChatState !== "idle" || isLiveSendBlocked) {
        return;
      }

      tryDrainQueuedMessage(state.queuedMessageBySession[sessionId]);
    });
  }, [sessionId, tryDrainQueuedMessage]);

  useEffect(() => {
    if (queuedMessageKey !== lastAttemptRef.current?.key) {
      lastAttemptRef.current = null;
    }
    if (queuedMessageKey !== failureStateRef.current?.key) {
      failureStateRef.current = null;
    }
  }, [queuedMessageKey]);

  useEffect(() => {
    if (chatState === "idle" && previousChatStateRef.current !== "idle") {
      if (suppressNextRenderIdleCycleRef.current) {
        suppressNextRenderIdleCycleRef.current = false;
      } else {
        idleCycleRef.current += 1;
      }
    }
    previousChatStateRef.current = chatState;
  }, [chatState]);

  useEffect(() => {
    if (chatState !== "idle" || isSendBlocked || readOnly) {
      return;
    }

    tryDrainQueuedMessage(queuedMessage);
  }, [
    chatState,
    isSendBlocked,
    queuedMessage,
    readOnly,
    tryDrainQueuedMessage,
  ]);

  const enqueue = useCallback(
    (
      text: string,
      personaId?: string,
      attachments?: ChatAttachmentDraft[],
      sendOptions?: ChatSendOptions,
    ) => {
      if (readOnly) {
        return;
      }
      useChatStore.getState().enqueueMessage(sessionId, {
        text,
        personaId,
        attachments,
        sendOptions,
      });
    },
    [readOnly, sessionId],
  );

  const dismiss = useCallback(() => {
    useChatStore.getState().dismissQueuedMessage(sessionId);
  }, [sessionId]);

  return { queuedMessage, enqueue, dismiss } as const;
}
