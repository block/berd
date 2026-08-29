import { useEffect } from "react";

import {
  assertQueuedSessionReady,
  isQueuedSessionReady,
} from "@/features/chat/lib/queuedMessageReadiness";
import { PreCommitSendRejectedError } from "@/features/chat/lib/preCommitSendRejection";
import {
  assertQueuedMessageAttemptOwned,
  becameQueuedMessageTargetAttemptable,
  isQueuedMessageTargetAttemptable,
} from "@/features/chat/lib/queuedMessageAttemptOwnership";
import {
  type QueuedMessageRecord,
  useChatStore,
} from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import {
  BerdctlDeliveryAlreadyAcceptedError,
  hasAcceptedBerdctlDeliveryInTranscript,
  isBerdctlCrossSessionQueuedMessage,
  sendPromptToExistingSessionInBackground,
} from "@/features/berdctl/commands/runtime/sessionSend";
import { SessionDispatchContentionError } from "@/features/chat/lib/sessionDispatchAcquisition";
import {
  isReclaimedQueueReconciliationPending,
  requestReclaimedQueueReconciliation,
  subscribeReclaimedQueueReconciliation,
} from "@/features/chat/lib/reclaimedQueueReconciliation";

const drainingSessionIds = new Set<string>();
const activeOwners = new Set<string>();
type ContentionWaiter = {
  ownerId: string;
  record: QueuedMessageRecord;
  cancel: () => void;
  releaseObserved: boolean;
  attemptSettled: boolean;
  resumeScheduled: boolean;
};

const contentionWaiters = new Map<string, ContentionWaiter>();

function ownerIdFor(scopedSessionId?: string): string {
  return scopedSessionId ? `session:${scopedSessionId}` : "global";
}

function cancelContentionWaiter(sessionId: string): void {
  contentionWaiters.get(sessionId)?.cancel();
  contentionWaiters.delete(sessionId);
}

function scheduleContentionResume(
  sessionId: string,
  waiter: ContentionWaiter,
): void {
  if (
    !waiter.releaseObserved ||
    !waiter.attemptSettled ||
    waiter.resumeScheduled ||
    contentionWaiters.get(sessionId) !== waiter
  ) {
    return;
  }
  waiter.resumeScheduled = true;
  contentionWaiters.delete(sessionId);
  queueMicrotask(() => drainQueuedMessage(sessionId, waiter.ownerId));
}

function drainQueuedMessage(queuedSessionId: string, ownerId: string): void {
  if (!activeOwners.has(ownerId)) return;
  if (isReclaimedQueueReconciliationPending(queuedSessionId)) return;
  const sessionExists = Boolean(
    useChatSessionStore.getState().getSession(queuedSessionId),
  );
  const currentRecord =
    useChatStore.getState().queuedMessageBySession[queuedSessionId]?.[0];
  const pendingWaiter = contentionWaiters.get(queuedSessionId);
  if (pendingWaiter) {
    if (sessionExists && pendingWaiter.record === currentRecord) return;
    cancelContentionWaiter(queuedSessionId);
  }
  if (drainingSessionIds.has(queuedSessionId)) {
    return;
  }

  const chatStore = useChatStore.getState();
  const queuedMessage = chatStore.queuedMessageBySession[queuedSessionId]?.[0];
  const runtime = chatStore.getSessionRuntime(queuedSessionId);
  if (
    !isQueuedMessageTargetAttemptable(
      queuedMessage,
      useChatSessionStore.getState().getSession(queuedSessionId),
    ) ||
    !isBerdctlCrossSessionQueuedMessage(queuedMessage) ||
    queuedMessage.releasedFromDeferred ||
    !isQueuedSessionReady(runtime)
  ) {
    return;
  }

  const deliveryId =
    queuedMessage.payload.sendOptions?.userMessageMetadata?.berdDeliveryId;
  if (
    deliveryId &&
    hasAcceptedBerdctlDeliveryInTranscript(queuedSessionId, deliveryId)
  ) {
    dismissQueuedMessageIfCurrent(queuedSessionId, queuedMessage);
    queueMicrotask(() => drainQueuedMessage(queuedSessionId, ownerId));
    return;
  }

  drainingSessionIds.add(queuedSessionId);
  const send = sendPromptToExistingSessionInBackground(
    queuedSessionId,
    queuedMessage.payload.text,
    () => {
      const state = useChatStore.getState();
      assertQueuedMessageAttemptOwned(
        state.queuedMessageBySession[queuedSessionId]?.[0],
        queuedMessage,
      );
      assertQueuedSessionReady(state.getSessionRuntime(queuedSessionId));
    },
    {
      returnOnDispatch: true,
      ...(queuedMessage.payload.sendOptions?.userMessageMetadata
        ?.berdSenderLabel ||
      queuedMessage.payload.sendOptions?.userMessageMetadata?.berdDeliveryId
        ? { sendOptions: queuedMessage.payload.sendOptions }
        : {}),
      ...(deliveryId
        ? {
            validateHydratedTranscript: () => {
              if (
                hasAcceptedBerdctlDeliveryInTranscript(
                  queuedSessionId,
                  deliveryId,
                )
              ) {
                throw new BerdctlDeliveryAlreadyAcceptedError();
              }
            },
          }
        : {}),
    },
  );
  let sendSucceeded = false;
  let shouldResumeDrain = false;
  let waitingForContention = false;
  void send
    .then(() => {
      sendSucceeded = true;
      dismissQueuedMessageIfCurrent(queuedSessionId, queuedMessage);
    })
    .catch((error) => {
      if (error instanceof BerdctlDeliveryAlreadyAcceptedError) {
        dismissQueuedMessageIfCurrent(queuedSessionId, queuedMessage);
        shouldResumeDrain = true;
        return;
      }
      if (error instanceof SessionDispatchContentionError) {
        waitingForContention = true;
        const waiter: ContentionWaiter = {
          ownerId,
          record: queuedMessage,
          cancel: () => undefined,
          releaseObserved: false,
          attemptSettled: false,
          resumeScheduled: false,
        };
        contentionWaiters.set(queuedSessionId, waiter);
        waiter.cancel = error.waiter.wait(() => {
          if (contentionWaiters.get(queuedSessionId) !== waiter) return;
          waiter.releaseObserved = true;
          scheduleContentionResume(queuedSessionId, waiter);
        });
        return;
      }
      if (error instanceof PreCommitSendRejectedError) {
        shouldResumeDrain = true;
        return;
      }
      console.error(
        `[berdctl-queue] failed to send queued prompt for session ${queuedSessionId}`,
        error,
      );
    })
    .finally(() => {
      drainingSessionIds.delete(queuedSessionId);
      if (waitingForContention) {
        const waiter = contentionWaiters.get(queuedSessionId);
        if (waiter?.record === queuedMessage) {
          waiter.attemptSettled = true;
          scheduleContentionResume(queuedSessionId, waiter);
        } else {
          queueMicrotask(() => drainQueuedMessage(queuedSessionId, ownerId));
        }
      } else if (sendSucceeded || shouldResumeDrain) {
        drainQueuedMessage(queuedSessionId, ownerId);
      }
    });
}

function dismissQueuedMessageIfCurrent(
  sessionId: string,
  queuedMessage: QueuedMessageRecord,
): boolean {
  const latestQueuedMessage =
    useChatStore.getState().queuedMessageBySession[sessionId]?.[0];
  if (
    latestQueuedMessage?.recordId !== queuedMessage.recordId ||
    latestQueuedMessage.payload !== queuedMessage.payload ||
    latestQueuedMessage.editing
  ) {
    return false;
  }
  useChatStore
    .getState()
    .dismissQueuedMessage(sessionId, queuedMessage.recordId);
  return true;
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

function reconcileContentionWaiters(scopedSessionId?: string): void {
  const sessionStore = useChatSessionStore.getState();
  const queue = useChatStore.getState().queuedMessageBySession;
  const owned = new Set(getQueuedSessionIds(queue, scopedSessionId));
  for (const [sessionId, waiter] of contentionWaiters) {
    if (
      (!scopedSessionId || sessionId === scopedSessionId) &&
      (!owned.has(sessionId) ||
        !sessionStore.getSession(sessionId) ||
        queue[sessionId]?.[0] !== waiter.record)
    ) {
      cancelContentionWaiter(sessionId);
    }
  }
}

function drainReadyQueuedMessages(scopedSessionId?: string): void {
  const ownerId = ownerIdFor(scopedSessionId);
  if (!activeOwners.has(ownerId)) return;
  reconcileContentionWaiters(scopedSessionId);
  const { queuedMessageBySession } = useChatStore.getState();
  for (const queuedSessionId of getQueuedSessionIds(
    queuedMessageBySession,
    scopedSessionId,
  )) {
    drainQueuedMessage(queuedSessionId, ownerId);
  }
}

export function useBerdctlQueuedMessageDrain(
  queuedSessionId?: string,
  ownerReady = true,
): void {
  useEffect(() => {
    if (!ownerReady) return;
    const ownerId = ownerIdFor(queuedSessionId);
    activeOwners.add(ownerId);
    drainReadyQueuedMessages(queuedSessionId);
    const unsubscribeWindowStore = queuedSessionId
      ? undefined
      : useSessionWindowStore.subscribe((state, previousState) => {
          if (
            state.hasLoadedSnapshot &&
            (!previousState.hasLoadedSnapshot ||
              state.openSessions !== previousState.openSessions)
          ) {
            if (
              !previousState.hasLoadedSnapshot ||
              !requestReclaimedQueueReconciliation(
                previousState.openSessions,
                state.openSessions,
              )
            ) {
              drainReadyQueuedMessages();
            }
          }
        });
    const unsubscribeReclaimedQueues = subscribeReclaimedQueueReconciliation(
      () => drainReadyQueuedMessages(queuedSessionId),
    );
    const unsubscribeSessionStore = useChatSessionStore.subscribe(
      (state, previousState) => {
        reconcileContentionWaiters(queuedSessionId);
        for (const sessionId of getQueuedSessionIds(
          useChatStore.getState().queuedMessageBySession,
          queuedSessionId,
        )) {
          const currentHead =
            useChatStore.getState().queuedMessageBySession[sessionId]?.[0];
          if (
            becameQueuedMessageTargetAttemptable(
              currentHead,
              currentHead,
              state.getSession(sessionId),
              previousState.sessions.find(
                (session) => session.id === sessionId,
              ),
            )
          ) {
            drainQueuedMessage(sessionId, ownerId);
          }
        }
        if (state.hasHydratedSessions && !previousState.hasHydratedSessions) {
          drainReadyQueuedMessages(queuedSessionId);
        }
      },
    );
    const unsubscribeChatStore = useChatStore.subscribe(
      (state, previousState) => {
        reconcileContentionWaiters(queuedSessionId);
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
            !isQueuedMessageTargetAttemptable(
              queuedMessage,
              useChatSessionStore.getState().getSession(queuedSessionId),
            ) ||
            !isBerdctlCrossSessionQueuedMessage(queuedMessage) ||
            queuedMessage.releasedFromDeferred
          ) {
            continue;
          }

          const currentRuntime = state.sessionStateById[queuedSessionId];
          const previousRuntime =
            previousState.sessionStateById[queuedSessionId];
          const currentBlocked = !isQueuedSessionReady(currentRuntime);
          const previousBlocked = !isQueuedSessionReady(previousRuntime);
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
            !currentBlocked &&
            (previousBlocked || becameTransportReady || becameReadyAfterEditing)
          ) {
            drainQueuedMessage(queuedSessionId, ownerId);
          }
        }
      },
    );
    return () => {
      unsubscribeWindowStore?.();
      unsubscribeReclaimedQueues();
      unsubscribeSessionStore();
      unsubscribeChatStore();
      activeOwners.delete(ownerId);
      for (const [sessionId, waiter] of contentionWaiters) {
        if (waiter.ownerId === ownerId) cancelContentionWaiter(sessionId);
      }
    };
  }, [ownerReady, queuedSessionId]);
}
