import { useEffect } from "react";
import { i18n } from "@/shared/i18n";

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
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  type QueuedMessageRecord,
  useChatStore,
} from "@/features/chat/stores/chatStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { SessionDispatchContentionError } from "@/features/chat/lib/sessionDispatchAcquisition";
import { sendQueuedPromptToExistingSessionInBackground } from "@/features/chat/lib/queuedSessionSend";

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

function reconcileContentionWaiters(scopedSessionId?: string): void {
  const sessionStore = useChatSessionStore.getState();
  const queue = useChatStore.getState().queuedMessageBySession;
  const owned = new Set(getOwnedSessionIds(queue, scopedSessionId));
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
  queueMicrotask(() => drainReleasedQueuedMessage(sessionId, waiter.ownerId));
}

function drainReleasedQueuedMessage(sessionId: string, ownerId: string): void {
  if (!activeOwners.has(ownerId)) return;
  const sessionExists = Boolean(
    useChatSessionStore.getState().getSession(sessionId),
  );
  const currentRecord =
    useChatStore.getState().queuedMessageBySession[sessionId]?.[0];
  const pendingWaiter = contentionWaiters.get(sessionId);
  if (pendingWaiter) {
    if (sessionExists && pendingWaiter.record === currentRecord) return;
    cancelContentionWaiter(sessionId);
  }
  if (drainingSessionIds.has(sessionId)) {
    return;
  }

  const chatStore = useChatStore.getState();
  const sessionStore = useChatSessionStore.getState();
  if (
    !sessionStore.hasHydratedSessions ||
    !sessionStore.getSession(sessionId)
  ) {
    return;
  }
  const queuedMessage = chatStore.queuedMessageBySession[sessionId]?.[0];
  const runtime = chatStore.getSessionRuntime(sessionId);
  if (
    !isQueuedMessageTargetAttemptable(
      queuedMessage,
      sessionStore.getSession(sessionId),
    ) ||
    !queuedMessage.releasedFromDeferred ||
    !isQueuedSessionReady(runtime)
  ) {
    return;
  }

  drainingSessionIds.add(sessionId);
  let waitingForContention = false;
  void sendQueuedPromptToExistingSessionInBackground(
    sessionId,
    queuedMessage,
    () => {
      const state = useChatStore.getState();
      assertQueuedMessageAttemptOwned(
        state.queuedMessageBySession[sessionId]?.[0],
        queuedMessage,
      );
      assertQueuedSessionReady(state.getSessionRuntime(sessionId));
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
        contentionWaiters.set(sessionId, waiter);
        waiter.cancel = error.waiter.wait(() => {
          if (contentionWaiters.get(sessionId) !== waiter) return;
          waiter.releaseObserved = true;
          scheduleContentionResume(sessionId, waiter);
        });
        return;
      }
      if (error instanceof PreCommitSendRejectedError) return;
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
      if (waitingForContention) {
        const waiter = contentionWaiters.get(sessionId);
        if (waiter?.record === queuedMessage) {
          waiter.attemptSettled = true;
          scheduleContentionResume(sessionId, waiter);
        } else {
          queueMicrotask(() => drainReleasedQueuedMessage(sessionId, ownerId));
        }
      } else {
        drainReleasedQueuedMessage(sessionId, ownerId);
      }
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
  const ownerId = ownerIdFor(scopedSessionId);
  if (!activeOwners.has(ownerId)) return;
  reconcileContentionWaiters(scopedSessionId);
  const { queuedMessageBySession } = useChatStore.getState();
  for (const sessionId of getOwnedSessionIds(
    queuedMessageBySession,
    scopedSessionId,
  )) {
    drainReleasedQueuedMessage(sessionId, ownerId);
  }
}

export function useReleasedQueuedMessageDrain(
  scopedSessionId?: string,
  ownerReady = true,
): void {
  useEffect(() => {
    if (!ownerReady) return;
    const ownerId = ownerIdFor(scopedSessionId);
    activeOwners.add(ownerId);
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
    const unsubscribeSessionStore = useChatSessionStore.subscribe(
      (state, previousState) => {
        reconcileContentionWaiters(scopedSessionId);
        for (const sessionId of getOwnedSessionIds(
          useChatStore.getState().queuedMessageBySession,
          scopedSessionId,
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
            drainReleasedQueuedMessage(sessionId, ownerId);
          }
        }
        if (state.hasHydratedSessions && !previousState.hasHydratedSessions) {
          drainReadyReleasedMessages(scopedSessionId);
        }
      },
    );
    const unsubscribeChatStore = useChatStore.subscribe(
      (state, previousState) => {
        reconcileContentionWaiters(scopedSessionId);
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
          const currentBlocked = !isQueuedSessionReady(currentRuntime);
          const previousBlocked = !isQueuedSessionReady(previousRuntime);
          const becameTransportReady =
            previousState.queuedMessageBySession[sessionId]?.[0] !==
            queuedMessage;
          if (
            currentChatState === "idle" &&
            !currentBlocked &&
            (previousBlocked || becameTransportReady)
          ) {
            drainReleasedQueuedMessage(sessionId, ownerId);
          }
        }
      },
    );
    return () => {
      unsubscribeWindowStore?.();
      unsubscribeSessionStore();
      unsubscribeChatStore();
      activeOwners.delete(ownerId);
      for (const [sessionId, waiter] of contentionWaiters) {
        if (waiter.ownerId === ownerId) cancelContentionWaiter(sessionId);
      }
    };
  }, [ownerReady, scopedSessionId]);
}
