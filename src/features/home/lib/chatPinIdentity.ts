/**
 * Identity of a pinned chat across draft promotion.
 *
 * A chat pinned before its first send is pinned under the draft session's
 * client-generated id. When that send creates the backend session, promotion
 * rewrites the pin in place (`replaceChatPinSessionId`), so a single pinned chat
 * can be stored under two ids over its life. Pin telemetry has to survive that:
 * a pin recorded before promotion and its resolution after it must still be
 * recognized as the same entity, or one user action reads as two.
 *
 * No chat id ever rides the wire — the pin events carry only `item_type` — so
 * the two ids answer bookkeeping questions only:
 *
 * - `keyId` — the id the session was first created under (its `clientSessionId`,
 *   or its own id when it never was a draft). Stable across promotion, so a pin
 *   recorded before promotion and an unpin recorded after it are recognized as
 *   acts on the same entity.
 * - `matchIds` — every id the pin may be stored under right now, since the
 *   confirmed layout can lag a promotion or arrive ahead of it.
 *
 * A session the store does not know — not loaded yet, or gone — resolves to
 * itself. That is the honest answer, and it keeps every ordinary chat pin
 * behaving exactly as it did before drafts entered the picture.
 */
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";

export interface ChatPinIdentity {
  /** Per-entity key, stable across promotion. */
  keyId: string;
  /** Every id the pin may currently be stored under. */
  matchIds: string[];
}

function findSession(
  sessions: readonly ChatSession[],
  sessionId: string,
): ChatSession | undefined {
  return (
    sessions.find((session) => session.id === sessionId) ??
    // Stored under the draft id it was pinned with, and since promoted.
    sessions.find((session) => session.clientSessionId === sessionId)
  );
}

function uniqueIds(ids: (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

export function resolveChatPinIdentity(sessionId: string): ChatPinIdentity {
  const session = findSession(
    useChatSessionStore.getState().sessions,
    sessionId,
  );
  if (!session) {
    return {
      keyId: sessionId,
      matchIds: [sessionId],
    };
  }

  return {
    keyId: session.clientSessionId ?? session.id,
    matchIds: uniqueIds([sessionId, session.id, session.clientSessionId]),
  };
}
