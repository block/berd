import { useEffect, useCallback, useMemo, useRef } from "react";
import type { ChatState } from "@/shared/types/chat";
import { isPromiseLike } from "@/shared/lib/isPromiseLike";
import type { ChatAttachmentDraft } from "@/shared/types/messages";
import {
  assertQueuedMessageAttemptOwned,
  becameQueuedMessageTargetAttemptable,
  isQueuedMessageTargetAttemptable,
} from "../lib/queuedMessageAttemptOwnership";
import {
  assertQueuedSessionReady,
  isQueuedSessionReady,
} from "../lib/queuedMessageReadiness";
import { useChatStore } from "../stores/chatStore";
import { useChatSessionStore } from "../stores/chatSessionStore";
import {
  acquireSessionDispatchTarget,
  type SessionDispatchTargetLease,
} from "../lib/sessionTargetCoordinator";
import type { QueuedMessageRecord } from "../stores/chatStore";
import type { ChatSendOptions } from "../types";
import type { SessionExecutionTarget } from "../lib/sessionExecutionTarget";
import {
  admitComposerQueuedMessage,
  personaIntentToOverride,
} from "../lib/admittedSend";

const EMPTY_QUEUED_RECORDS: QueuedMessageRecord[] = [];

interface QueueAttemptLease {
  recordId: string;
  payload: QueuedMessageRecord["payload"];
  targetLease: SessionDispatchTargetLease;
}

// Queue ownership must outlive any one React owner. Detached/reattached views can
// remount while a transport promise is unresolved; a module-scoped lease keeps
// the replacement owner from overlapping the still-live attempt.
const queueAttemptLeaseBySession = new Map<string, QueueAttemptLease>();

function getQueuedMessageKey(
  queuedMessage: QueuedMessageRecord | null,
): string | null {
  return queuedMessage?.kind === "transport-ready"
    ? queuedMessage.recordId
    : null;
}

function isBerdctlCrossSessionQueuedMessage(
  queuedMessage: QueuedMessageRecord | null,
): boolean {
  return (
    queuedMessage?.kind === "transport-ready" &&
    queuedMessage.payload.sendOptions?.userMessageMetadata?.origin ===
      "berdctl_cross_session"
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
    overridePersona?: { id: string | null; name?: string },
    attachments?: ChatAttachmentDraft[],
    sendOptions?: ChatSendOptions,
  ) => boolean | Promise<boolean>,
  readOnly = false,
  isSendBlocked = false,
  isPreparationReady = true,
) {
  const queuedRecords = useChatStore(
    (s) => s.queuedMessageBySession[sessionId] ?? EMPTY_QUEUED_RECORDS,
  );
  const queuedRecord = queuedRecords[0] ?? null;
  const queuedMessage =
    queuedRecord?.kind === "transport-ready" ? queuedRecord.payload : null;
  const previousChatStateRef = useRef(chatState);
  const idleCycleRef = useRef(0);
  const lastAttemptRef = useRef<{
    key: string;
    payload: QueuedMessageRecord["payload"];
    idleCycle: number;
  } | null>(null);
  const inFlightAttemptKeyRef = useRef<string | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dispatchReleaseUnsubscribeRef = useRef<(() => void) | null>(null);
  const dispatchReleasePayloadRef = useRef<
    QueuedMessageRecord["payload"] | null
  >(null);
  const automaticallyRetriedPayloadRef = useRef<
    QueuedMessageRecord["payload"] | null
  >(null);
  const suppressNextRenderIdleCycleRef = useRef(false);
  const queuedMessageKey = useMemo(
    () => getQueuedMessageKey(queuedRecord),
    [queuedRecord],
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
  const isPreparationReadyRef = useRef(isPreparationReady);
  isPreparationReadyRef.current = isPreparationReady;

  const tryDrainQueuedMessage = useCallback(
    (queuedMsg: QueuedMessageRecord | null | undefined) => {
      if (
        readOnlyRef.current ||
        !isQueuedMessageTargetAttemptable(
          queuedMsg,
          useChatSessionStore.getState().getSession(sessionId),
        ) ||
        queuedMsg.restored ||
        queuedMsg.releasedFromDeferred ||
        isBerdctlCrossSessionQueuedMessage(queuedMsg)
      ) {
        return false;
      }
      const liveRuntime = useChatStore.getState().getSessionRuntime(sessionId);
      if (!isQueuedSessionReady(liveRuntime, isPreparationReadyRef.current)) {
        return false;
      }

      const { payload } = queuedMsg;

      const key = getQueuedMessageKey(queuedMsg);
      if (!key) {
        return false;
      }

      const alreadyAttemptedThisIdleCycle =
        lastAttemptRef.current?.key === key &&
        lastAttemptRef.current.payload === payload &&
        lastAttemptRef.current.idleCycle === idleCycleRef.current;
      const activeLease = queueAttemptLeaseBySession.get(sessionId);
      const alreadySending =
        (activeLease?.recordId === key && activeLease.payload === payload) ||
        inFlightAttemptKeyRef.current === key;
      if (alreadyAttemptedThisIdleCycle || alreadySending) {
        return false;
      }

      if (dispatchReleaseUnsubscribeRef.current) {
        return false;
      }
      const acquisition = acquireSessionDispatchTarget(sessionId);
      if (acquisition.status === "contended") {
        dispatchReleasePayloadRef.current = payload;
        dispatchReleaseUnsubscribeRef.current = acquisition.waiter.wait(() => {
          dispatchReleaseUnsubscribeRef.current = null;
          dispatchReleasePayloadRef.current = null;
          const state = useChatStore.getState();
          const currentHead = state.queuedMessageBySession[sessionId]?.[0];
          if (
            currentHead &&
            isQueuedSessionReady(
              state.getSessionRuntime(sessionId),
              isPreparationReadyRef.current,
            )
          ) {
            tryDrainQueuedMessage(currentHead);
          }
        });
        return false;
      }
      if (acquisition.status !== "acquired") {
        return false;
      }
      const targetLease = acquisition;
      lastAttemptRef.current = {
        key,
        payload,
        idleCycle: idleCycleRef.current,
      };
      inFlightAttemptKeyRef.current = key;
      queueAttemptLeaseBySession.set(sessionId, {
        recordId: key,
        payload,
        targetLease,
      });

      const { text, persona, attachments, sendOptions } = payload;
      const queuedPersona = personaIntentToOverride(persona);
      let userMessageCommitted = false;
      const queuedSendOptions = {
        ...sendOptions,
        beforeUserMessageCommitted: () => {
          const state = useChatStore.getState();
          const latestQueuedMessage =
            state.queuedMessageBySession[sessionId]?.[0];
          assertQueuedMessageAttemptOwned(latestQueuedMessage, queuedMsg);
          assertQueuedSessionReady(
            state.getSessionRuntime(sessionId),
            isPreparationReadyRef.current,
          );
        },
        onUserMessageCommitted: () => {
          userMessageCommitted = true;
          sendOptions?.onUserMessageCommitted?.();
        },
        sessionSelection: targetLease.target,
        sessionSelectionToken: targetLease.token,
      };
      const sendFn = sendMessageRef.current;

      const finalize = (accepted: boolean | undefined) => {
        if (userMessageCommitted) {
          accepted = true;
        }
        if (inFlightAttemptKeyRef.current === key) {
          inFlightAttemptKeyRef.current = null;
        }
        const activeLease = queueAttemptLeaseBySession.get(sessionId);
        if (activeLease?.recordId === key && activeLease.payload === payload) {
          queueAttemptLeaseBySession.delete(sessionId);
          activeLease.targetLease.release();
        }

        const latestQueuedMessage =
          useChatStore.getState().queuedMessageBySession[sessionId]?.[0] ??
          null;
        if (
          getQueuedMessageKey(latestQueuedMessage) !== key ||
          latestQueuedMessage?.payload !== payload ||
          latestQueuedMessage.editing
        ) {
          if (
            latestQueuedMessage?.kind === "transport-ready" &&
            !latestQueuedMessage.editing
          ) {
            queueMicrotask(() => tryDrainQueuedMessage(latestQueuedMessage));
          }
          return;
        }

        if (accepted === false) {
          let retryPayload = latestQueuedMessage.payload;
          if (retryPayload.showInComposer === false) {
            retryPayload = {
              ...retryPayload,
              showInComposer: true,
            };
            lastAttemptRef.current = {
              key,
              payload: retryPayload,
              idleCycle: idleCycleRef.current,
            };
            useChatStore
              .getState()
              .updateQueuedMessage(
                sessionId,
                latestQueuedMessage.recordId,
                retryPayload,
              );
          }
          if (
            retryTimerRef.current === null &&
            automaticallyRetriedPayloadRef.current !== retryPayload
          ) {
            retryTimerRef.current = setTimeout(() => {
              retryTimerRef.current = null;
              const state = useChatStore.getState();
              const runtime = state.getSessionRuntime(sessionId);
              const retryHead = state.queuedMessageBySession[sessionId]?.[0];
              if (
                !isQueuedSessionReady(runtime, isPreparationReadyRef.current) ||
                getQueuedMessageKey(retryHead) !== key ||
                retryHead?.payload !== retryPayload
              ) {
                return;
              }
              automaticallyRetriedPayloadRef.current = retryPayload;
              idleCycleRef.current += 1;
              tryDrainQueuedMessage(retryHead);
            }, 1_000);
          }
          return;
        }

        automaticallyRetriedPayloadRef.current = null;
        lastAttemptRef.current = null;
        useChatStore
          .getState()
          .dismissQueuedMessage(sessionId, queuedMsg.recordId);
      };

      let sendResult: boolean | Promise<boolean>;
      try {
        sendResult = sendFn(
          text,
          queuedPersona,
          attachments,
          queuedSendOptions,
        );
      } catch {
        finalize(false);
        return true;
      }

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
      const isLiveSendBlocked = !isQueuedSessionReady(runtime);
      const wasSendBlocked = !isQueuedSessionReady(previousRuntime);
      const becameIdle =
        currentChatState === "idle" && prevChatState !== "idle";
      const becameReadyWhileIdle =
        currentChatState === "idle" && wasSendBlocked && !isLiveSendBlocked;
      const queuedMessage = state.queuedMessageBySession[sessionId]?.[0];
      const previousQueuedMessage =
        previousState.queuedMessageBySession[sessionId]?.[0];
      const becameTransportReady =
        queuedMessage?.kind === "transport-ready" &&
        previousQueuedMessage?.kind === "deferred" &&
        previousQueuedMessage.recordId === queuedMessage.recordId;
      const becameReadyAfterRestore =
        queuedMessage?.kind === "transport-ready" &&
        !queuedMessage.restored &&
        previousQueuedMessage?.recordId === queuedMessage.recordId &&
        previousQueuedMessage.restored === true;
      const editedCurrentRecord =
        queuedMessage?.kind === "transport-ready" &&
        previousQueuedMessage?.recordId === queuedMessage.recordId &&
        previousQueuedMessage.payload !== queuedMessage.payload &&
        previousQueuedMessage.editing === true &&
        !queuedMessage.editing;
      const advancedToNextRecord =
        queuedMessage?.recordId !== previousQueuedMessage?.recordId &&
        previousQueuedMessage !== undefined;

      if (editedCurrentRecord || advancedToNextRecord) {
        automaticallyRetriedPayloadRef.current = null;
        if (retryTimerRef.current !== null) {
          clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
      }

      if (becameIdle || becameReadyWhileIdle) {
        automaticallyRetriedPayloadRef.current = null;
        if (retryTimerRef.current !== null) {
          clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
        idleCycleRef.current += 1;
        suppressNextRenderIdleCycleRef.current = true;
      }

      if (
        !becameIdle &&
        !becameReadyWhileIdle &&
        !becameTransportReady &&
        !becameReadyAfterRestore &&
        !editedCurrentRecord &&
        !advancedToNextRecord
      ) {
        return;
      }

      if (currentChatState !== "idle" || isLiveSendBlocked) {
        return;
      }

      tryDrainQueuedMessage(queuedMessage);
    });
  }, [sessionId, tryDrainQueuedMessage]);

  useEffect(() => {
    return () => {
      dispatchReleaseUnsubscribeRef.current?.();
      dispatchReleaseUnsubscribeRef.current = null;
      dispatchReleasePayloadRef.current = null;
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (dispatchReleasePayloadRef.current !== queuedRecord?.payload) {
      dispatchReleaseUnsubscribeRef.current?.();
      dispatchReleaseUnsubscribeRef.current = null;
      dispatchReleasePayloadRef.current = null;
    }
    if (queuedMessageKey !== lastAttemptRef.current?.key) {
      lastAttemptRef.current = null;
      automaticallyRetriedPayloadRef.current = null;
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    }
  }, [queuedMessageKey, queuedRecord]);

  useEffect(() => {
    return useChatSessionStore.subscribe((state, previousState) => {
      const currentSession = state.getSession(sessionId);
      if (!currentSession) {
        dispatchReleaseUnsubscribeRef.current?.();
        dispatchReleaseUnsubscribeRef.current = null;
        dispatchReleasePayloadRef.current = null;
        return;
      }
      const currentHead =
        useChatStore.getState().queuedMessageBySession[sessionId]?.[0];
      if (
        becameQueuedMessageTargetAttemptable(
          currentHead,
          currentHead,
          currentSession,
          previousState.sessions.find((session) => session.id === sessionId),
        )
      ) {
        tryDrainQueuedMessage(currentHead);
      }
    });
  }, [sessionId, tryDrainQueuedMessage]);

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

    tryDrainQueuedMessage(queuedRecord);
  }, [chatState, isSendBlocked, queuedRecord, readOnly, tryDrainQueuedMessage]);

  const enqueue = useCallback(
    (
      text: string,
      personaId?: string | null,
      attachments?: ChatAttachmentDraft[],
      sendOptions?: ChatSendOptions,
      personaName?: string,
      _legacyExecutionTarget?: SessionExecutionTarget,
    ) => {
      if (readOnly) {
        return false;
      }
      return useChatStore.getState().enqueueTransportReadyMessage(
        sessionId,
        admitComposerQueuedMessage({
          text,
          personaId,
          personaName,
          attachments,
          sendOptions,
        }),
      );
    },
    [readOnly, sessionId],
  );

  const dismiss = useCallback(
    (recordId?: string) => {
      const targetId = recordId ?? queuedRecord?.recordId;
      if (targetId) {
        useChatStore.getState().dismissQueuedMessage(sessionId, targetId);
      }
    },
    [queuedRecord, sessionId],
  );

  const update = useCallback(
    (recordId: string, payload: QueuedMessageRecord["payload"]) =>
      useChatStore.getState().updateQueuedMessage(sessionId, recordId, payload),
    [sessionId],
  );

  const beginEditing = useCallback(
    (recordId: string) =>
      useChatStore
        .getState()
        .setQueuedMessageEditing(sessionId, recordId, true),
    [sessionId],
  );

  const cancelEditing = useCallback(
    (recordId: string) =>
      useChatStore
        .getState()
        .setQueuedMessageEditing(sessionId, recordId, false),
    [sessionId],
  );

  return {
    queuedMessage,
    queuedRecord,
    queuedRecords,
    enqueue,
    dismiss,
    update,
    beginEditing,
    cancelEditing,
  } as const;
}
