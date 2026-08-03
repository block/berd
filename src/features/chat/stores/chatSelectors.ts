import type { ChatStore } from "./chatStore";

// Derived counts are recomputed only when the underlying messagesBySession
// reference changes, and the result is kept reference-stable when the per-
// session counts are unchanged. Streaming text appends mutate message arrays
// (new messagesBySession ref) without changing counts, so this turns the
// per-subscriber O(sessions) recompute into one shared O(sessions) pass per
// store update and a stable reference downstream.
let cachedMessagesBySession: ChatStore["messagesBySession"] | null = null;
let cachedQueuedMessageBySession: ChatStore["queuedMessageBySession"] | null =
  null;
let cachedCounts: Record<string, number> = {};

export const selectLocalMessageCountsBySession = (
  state: ChatStore,
): Record<string, number> => {
  const messagesBySession = state.messagesBySession;
  const queuedMessageBySession = state.queuedMessageBySession ?? {};
  if (
    messagesBySession === cachedMessagesBySession &&
    queuedMessageBySession === cachedQueuedMessageBySession
  ) {
    return cachedCounts;
  }

  const next: Record<string, number> = {};
  let changed = false;
  const sessionIds = new Set([
    ...Object.keys(messagesBySession),
    ...Object.keys(queuedMessageBySession),
  ]);
  for (const sessionId of sessionIds) {
    const count = Math.max(
      messagesBySession[sessionId]?.length ?? 0,
      queuedMessageBySession[sessionId]?.length ?? 0,
    );
    next[sessionId] = count;
    if (cachedCounts[sessionId] !== count) {
      changed = true;
    }
  }
  if (Object.keys(next).length !== Object.keys(cachedCounts).length) {
    changed = true;
  }

  cachedMessagesBySession = messagesBySession;
  cachedQueuedMessageBySession = queuedMessageBySession;
  if (changed) {
    cachedCounts = next;
  }
  return cachedCounts;
};

export const selectSessionStateById = (state: ChatStore) =>
  state.sessionStateById;

export const selectDraftsBySession = (state: ChatStore) =>
  state.draftsBySession;

export const selectNonEmptyDraftSessionIds = (state: ChatStore) =>
  state.nonEmptyDraftSessionIds;
