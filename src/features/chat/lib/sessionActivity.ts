import type { ChatState } from "@/shared/types/chat";

export function isSessionRunning(chatState: ChatState): boolean {
  return (
    chatState === "thinking" ||
    chatState === "streaming" ||
    chatState === "waiting" ||
    chatState === "compacting"
  );
}

/** A new window needs a live snapshot until the runtime and stream are settled. */
export function sessionNeedsWindowHandoff(runtime: {
  chatState: ChatState;
  streamingMessageId?: string | null;
}): boolean {
  return (
    isSessionRunning(runtime.chatState) || Boolean(runtime.streamingMessageId)
  );
}

interface SessionActivityTimestamp {
  lastMessageAt?: string | null;
  updatedAt: string;
}

/**
 * User-visible session activity is the latest real chat message when the backend
 * can provide it. `updatedAt` remains the fallback for new/draft sessions and
 * older Goose backends that do not yet expose `_meta.lastMessageAt`.
 */
export function sessionActivityAt(session: SessionActivityTimestamp): string {
  const lastMessageAt = session.lastMessageAt?.trim();
  if (lastMessageAt && Number.isFinite(Date.parse(lastMessageAt))) {
    return lastMessageAt;
  }
  return session.updatedAt;
}

export function compareSessionsByActivityDesc<
  T extends SessionActivityTimestamp & { id?: string },
>(a: T, b: T): number {
  const aTime = Date.parse(sessionActivityAt(a));
  const bTime = Date.parse(sessionActivityAt(b));

  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
    return bTime - aTime;
  }
  if (Number.isFinite(aTime) !== Number.isFinite(bTime)) {
    return Number.isFinite(bTime) ? 1 : -1;
  }

  const idCompare = (b.id ?? "").localeCompare(a.id ?? "");
  if (idCompare !== 0) return idCompare;

  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}
