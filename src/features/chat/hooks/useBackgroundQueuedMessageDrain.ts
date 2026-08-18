import { useEffect } from "react";
import { toast } from "sonner";
import { i18n } from "@/shared/i18n";

import {
  assertQueuedSessionReady,
  isQueuedSessionReady,
  QueuedSessionNotReadyError,
} from "@/features/chat/lib/queuedMessageReadiness";
import { PreCommitSendRejectedError } from "@/features/chat/lib/preCommitSendRejection";
import {
  assertQueuedMessageAttemptOwned,
  becameQueuedMessageTargetAttemptable,
  isQueuedMessageTargetAttemptable,
} from "@/features/chat/lib/queuedMessageAttemptOwnership";
import {
  hasForegroundQueueOwner,
  subscribeForegroundQueueOwnership,
} from "@/features/chat/lib/foregroundQueueOwnership";
import { isBerdctlCrossSessionQueuedMessage } from "@/features/chat/lib/queuedMessageOrigin";
import { isAgentBuilderQueuePreparationReady } from "@/features/chat/lib/agentBuilderQueueReadiness";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  type QueuedMessageRecord,
  useChatStore,
} from "@/features/chat/stores/chatStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { SessionDispatchContentionError } from "@/features/chat/lib/sessionDispatchAcquisition";
import {
  isReclaimedQueueReconciliationPending,
  requestReclaimedQueueReconciliation,
  subscribeReclaimedQueueReconciliation,
} from "@/features/chat/lib/reclaimedQueueReconciliation";
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

// Record ids observed with `restored: true` this app run, per session. The
// flag itself is cleared by `markQueuedMessagesReady` during any session
// load — including loads the user did not initiate (e.g. a berdctl
// cross-session send touching the session) — so the flag alone cannot
// guarantee "the user reopened this chat". A session's exclusions lift only
// when a foreground owner registers for it, which is the user actually
// opening the chat.
const restoredExclusionsBySession = new Map<string, Set<string>>();

function noteRestoredRecords(
  queuedMessageBySession: Record<string, QueuedMessageRecord[]>,
): void {
  for (const [sessionId, records] of Object.entries(queuedMessageBySession)) {
    if (hasForegroundQueueOwner(sessionId)) continue;
    for (const record of records) {
      if (!record.restored) continue;
      let exclusions = restoredExclusionsBySession.get(sessionId);
      if (!exclusions) {
        exclusions = new Set();
        restoredExclusionsBySession.set(sessionId, exclusions);
      }
      exclusions.add(record.recordId);
    }
  }
}

function liftRestoredExclusionsForOwnedSessions(): void {
  for (const sessionId of restoredExclusionsBySession.keys()) {
    if (hasForegroundQueueOwner(sessionId)) {
      restoredExclusionsBySession.delete(sessionId);
    }
  }
}

function isRestoredExcluded(
  sessionId: string,
  record: QueuedMessageRecord & { kind: "transport-ready" },
): boolean {
  return (
    record.restored === true ||
    (restoredExclusionsBySession.get(sessionId)?.has(record.recordId) ?? false)
  );
}

function ownerIdFor(scopedSessionId?: string): string {
  return scopedSessionId ? `session:${scopedSessionId}` : "global";
}

/**
 * Foreground ownership of a promoted chat's queue, spanning the id swap.
 *
 * Promotion re-keys the queue to the backend id synchronously, but the mounted
 * ChatView is still registered under the renderer-local draft id until React
 * commits the new `sessionId` into `useMessageQueue`. A promoted session keeps
 * that draft id as its `clientSessionId`, so honoring both ids keeps the
 * hand-off instant from looking unowned — otherwise this drain claims the head
 * the foreground owner is about to send, and its hydration then races that
 * send.
 */
function hasForegroundQueueOwnerAcrossPromotion(sessionId: string): boolean {
  if (hasForegroundQueueOwner(sessionId)) {
    return true;
  }
  const clientSessionId = useChatSessionStore
    .getState()
    .getSession(sessionId)?.clientSessionId;
  return (
    clientSessionId !== undefined &&
    clientSessionId !== sessionId &&
    hasForegroundQueueOwner(clientSessionId)
  );
}

export function resetBackgroundQueueDrainStateForTesting(): void {
  restoredExclusionsBySession.clear();
}

/**
 * The background drain claims a queued head when either
 * - it was released from a deferred workspace send (the foreground queue never
 *   claims released heads), or
 * - no mounted foreground chat currently owns the session's queue, so nothing
 *   else will send it (the user queued a message and left the chat).
 *
 * berdctl cross-session sends are excluded; they have a dedicated drain.
 * Ordinary heads restored from persistence are excluded so an app relaunch
 * does not fire stale prompts without the user reopening the chat; the
 * exclusion is tracked per record id so an incidental session load clearing
 * the `restored` flag cannot lift it.
 */
function isBackgroundDrainableHead(
  record: QueuedMessageRecord & { kind: "transport-ready" },
  sessionId: string,
): boolean {
  if (
    isBerdctlCrossSessionQueuedMessage(record) ||
    !isAgentBuilderQueuePreparationReady(
      record,
      useChatSessionStore.getState().getSession(sessionId),
    )
  ) {
    return false;
  }
  if (record.releasedFromDeferred) {
    return true;
  }
  return (
    !isRestoredExcluded(sessionId, record) &&
    !hasForegroundQueueOwnerAcrossPromotion(sessionId)
  );
}

/**
 * A session window keeps the authoritative queue while its session is open;
 * this renderer's in-memory copy goes stale. When windows close, reload the
 * reclaimed sessions' queues from persistence before draining so a stale
 * head that the window already sent, edited, or dismissed cannot fire again.
 * Reconciled records arrive `restored: true`, which the background drain
 * refuses to claim.
 */
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
  queueMicrotask(() => drainQueuedMessage(sessionId, waiter.ownerId));
}

function drainQueuedMessage(sessionId: string, ownerId: string): void {
  if (!activeOwners.has(ownerId)) return;
  if (isReclaimedQueueReconciliationPending(sessionId)) return;
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
    !isBackgroundDrainableHead(queuedMessage, sessionId) ||
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
      if (
        !isAgentBuilderQueuePreparationReady(
          queuedMessage,
          useChatSessionStore.getState().getSession(sessionId),
        )
      ) {
        throw new QueuedSessionNotReadyError();
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
      const message = i18n.t("chat:queue.backgroundSendFailed");
      console.error(
        `[background-queue] failed to send queued prompt for session ${sessionId}`,
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
        // The user is not viewing this chat (the background drain only
        // claims unowned sessions), so a parked failure would otherwise be
        // invisible until they reopen it. Surface it where they are now.
        const sessionTitle = useChatSessionStore
          .getState()
          .getSession(sessionId)
          ?.title?.trim();
        toast.error(
          sessionTitle || i18n.t("chat:queue.backgroundSendFailedTitle"),
          { description: message },
        );
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
          queueMicrotask(() => drainQueuedMessage(sessionId, ownerId));
        }
      } else {
        drainQueuedMessage(sessionId, ownerId);
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

function drainReadyQueuedMessages(scopedSessionId?: string): void {
  const ownerId = ownerIdFor(scopedSessionId);
  if (!activeOwners.has(ownerId)) return;
  reconcileContentionWaiters(scopedSessionId);
  const { queuedMessageBySession } = useChatStore.getState();
  noteRestoredRecords(queuedMessageBySession);
  for (const sessionId of getOwnedSessionIds(
    queuedMessageBySession,
    scopedSessionId,
  )) {
    drainQueuedMessage(sessionId, ownerId);
  }
}

export function useBackgroundQueuedMessageDrain(
  scopedSessionId?: string,
  ownerReady = true,
): void {
  useEffect(() => {
    if (!ownerReady) return;
    const ownerId = ownerIdFor(scopedSessionId);
    activeOwners.add(ownerId);
    drainReadyQueuedMessages(scopedSessionId);
    const unsubscribeWindowStore = scopedSessionId
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
    // When a foreground chat releases queue ownership (the user left the
    // chat), any ready queued head it never sent becomes ours to send.
    // Registration also lifts restored-head exclusions: the user reopening
    // the chat is the signal that a persisted head is theirs to send again.
    const unsubscribeForegroundOwnership = subscribeForegroundQueueOwnership(
      () => {
        liftRestoredExclusionsForOwnedSessions();
        drainReadyQueuedMessages(scopedSessionId);
      },
    );
    const unsubscribeReclaimedQueues = subscribeReclaimedQueueReconciliation(
      () => drainReadyQueuedMessages(scopedSessionId),
    );
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
            drainQueuedMessage(sessionId, ownerId);
          }
        }
        if (state.hasHydratedSessions && !previousState.hasHydratedSessions) {
          drainReadyQueuedMessages(scopedSessionId);
        }
      },
    );
    const unsubscribeChatStore = useChatStore.subscribe(
      (state, previousState) => {
        reconcileContentionWaiters(scopedSessionId);
        noteRestoredRecords(state.queuedMessageBySession);
        for (const sessionId of getOwnedSessionIds(
          state.queuedMessageBySession,
          scopedSessionId,
        )) {
          const queuedMessage = state.queuedMessageBySession[sessionId]?.[0];
          if (
            queuedMessage?.kind !== "transport-ready" ||
            !isBackgroundDrainableHead(queuedMessage, sessionId)
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
            drainQueuedMessage(sessionId, ownerId);
          }
        }
      },
    );
    return () => {
      unsubscribeWindowStore?.();
      unsubscribeReclaimedQueues();
      unsubscribeForegroundOwnership();
      unsubscribeSessionStore();
      unsubscribeChatStore();
      activeOwners.delete(ownerId);
      for (const [sessionId, waiter] of contentionWaiters) {
        if (waiter.ownerId === ownerId) cancelContentionWaiter(sessionId);
      }
    };
  }, [ownerReady, scopedSessionId]);
}
