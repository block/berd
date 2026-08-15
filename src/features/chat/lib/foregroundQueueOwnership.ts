/**
 * Registry of sessions whose queue is currently owned by a mounted foreground
 * drain (`useMessageQueue` inside an interactive ChatView). The background
 * queue drain defers to a registered foreground owner so exactly one drain
 * claims each queued head by design; the session dispatch lease and queued
 * message ownership assertions remain the safety net for mount races.
 */

const ownerCountsBySession = new Map<string, number>();
const listeners = new Set<() => void>();

function notifyOwnershipChanged(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

export function registerForegroundQueueOwner(sessionId: string): () => void {
  ownerCountsBySession.set(
    sessionId,
    (ownerCountsBySession.get(sessionId) ?? 0) + 1,
  );
  notifyOwnershipChanged();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = ownerCountsBySession.get(sessionId) ?? 0;
    if (count <= 1) {
      ownerCountsBySession.delete(sessionId);
    } else {
      ownerCountsBySession.set(sessionId, count - 1);
    }
    notifyOwnershipChanged();
  };
}

export function hasForegroundQueueOwner(sessionId: string): boolean {
  return (ownerCountsBySession.get(sessionId) ?? 0) > 0;
}

export function subscribeForegroundQueueOwnership(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetForegroundQueueOwnershipForTesting(): void {
  ownerCountsBySession.clear();
}
