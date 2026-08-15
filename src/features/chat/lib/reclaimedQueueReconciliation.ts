import { useChatStore } from "@/features/chat/stores/chatStore";
import { loadPersistedMessageQueues } from "@/features/chat/stores/queuePersistence";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";

const pendingSessionIds = new Set<string>();
const blockedSessionIds = new Set<string>();
const listeners = new Set<() => void>();
let worker: Promise<void> | undefined;
let lastObservedOpenSessions: Record<string, string> | undefined;

function notifyReconciled(): void {
  for (const listener of [...listeners]) listener();
}

async function reconcilePendingQueues(): Promise<void> {
  while (pendingSessionIds.size > 0) {
    const batch = [...pendingSessionIds];
    pendingSessionIds.clear();
    try {
      const persistedQueues = await loadPersistedMessageQueues();
      const { openSessions } = useSessionWindowStore.getState();
      const stillReclaimed = batch.filter(
        (sessionId) => !(sessionId in openSessions),
      );
      if (stillReclaimed.length > 0) {
        useChatStore
          .getState()
          .reconcileQueuedMessages(persistedQueues, stillReclaimed);
      }
    } finally {
      for (const sessionId of batch) blockedSessionIds.delete(sessionId);
      notifyReconciled();
    }
  }
}

/**
 * Reconciles queues returning from detached session windows before any global
 * drain may act on the main renderer's stale in-memory copy. Overlapping
 * window closes accumulate behind one worker; each reclaimed session remains
 * blocked until a persistence read covering it has settled.
 */
function ensureWorker(): void {
  if (worker) return;
  worker = Promise.resolve()
    .then(reconcilePendingQueues)
    .finally(() => {
      worker = undefined;
      if (pendingSessionIds.size > 0) ensureWorker();
    });
}

export function requestReclaimedQueueReconciliation(
  previousOpenSessions: Record<string, string>,
  openSessions: Record<string, string>,
): boolean {
  if (lastObservedOpenSessions === openSessions) return false;
  lastObservedOpenSessions = openSessions;
  const reclaimedSessionIds = Object.keys(previousOpenSessions).filter(
    (sessionId) =>
      !(sessionId in openSessions) && !blockedSessionIds.has(sessionId),
  );
  if (reclaimedSessionIds.length === 0) return false;

  for (const sessionId of reclaimedSessionIds) {
    blockedSessionIds.add(sessionId);
    pendingSessionIds.add(sessionId);
  }
  ensureWorker();
  return true;
}

export function isReclaimedQueueReconciliationPending(
  sessionId: string,
): boolean {
  return blockedSessionIds.has(sessionId);
}

export function subscribeReclaimedQueueReconciliation(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetReclaimedQueueReconciliationForTesting(): void {
  pendingSessionIds.clear();
  blockedSessionIds.clear();
  listeners.clear();
  worker = undefined;
  lastObservedOpenSessions = undefined;
}
