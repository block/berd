import { sessionActivityAt } from "@/features/chat/lib/sessionActivity";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";

interface HomeWidgetPin {
  type: string;
  state?: Record<string, unknown>;
}

export interface AutoArchiveSessionCandidateOptions {
  sessions: ChatSession[];
  homeWidgets: HomeWidgetPin[];
  afterMs: number | null;
  nowMs?: number;
}

export function getPinnedChatSessionIds(
  homeWidgets: HomeWidgetPin[],
): Set<string> {
  const sessionIds = new Set<string>();
  for (const widget of homeWidgets) {
    const sessionId = widget.state?.sessionId;
    if (widget.type === "chatPin" && typeof sessionId === "string") {
      sessionIds.add(sessionId);
    }
  }
  return sessionIds;
}

/**
 * Select inactive sessions that are safe to consider for automatic archiving.
 * The caller remains responsible for checking live runtime state and applying
 * the normal archive transaction.
 */
export function getAutoArchiveSessionCandidates({
  sessions,
  homeWidgets,
  afterMs,
  nowMs = Date.now(),
}: AutoArchiveSessionCandidateOptions): ChatSession[] {
  if (afterMs === null) return [];

  const pinnedSessionIds = getPinnedChatSessionIds(homeWidgets);
  const cutoffMs = nowMs - afterMs;

  return sessions.filter((session) => {
    if (
      session.archivedAt ||
      session.creationState ||
      session.pinnedLoadState ||
      pinnedSessionIds.has(session.id)
    ) {
      return false;
    }

    const activityMs = Date.parse(sessionActivityAt(session));
    return Number.isFinite(activityMs) && activityMs <= cutoffMs;
  });
}
