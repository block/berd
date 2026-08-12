import { compareSessionsByActivityDesc } from "@/features/chat/lib/sessionActivity";

export interface CycleSession {
  id: string;
  updatedAt: string;
  lastMessageAt?: string | null;
}

export type SessionCycleDirection = 1 | -1;

/**
 * Resolve the session Ctrl+Tab-style cycling should activate next.
 *
 * Sessions default to most-recently-active order and wrap at both ends.
 * When no candidate is active (home view, or a draft/archived/other-window
 * session), both directions enter the list at the most recent session —
 * "switch sessions" from outside the list means "go to the last one used".
 *
 * Returns null when there is nowhere to go (no candidates, or the active
 * session is the only one).
 */
export function resolveSessionCycleTarget(
  sessions: readonly CycleSession[],
  activeSessionId: string | null,
  direction: SessionCycleDirection,
): string | null {
  if (sessions.length === 0) {
    return null;
  }
  const ordered = [...sessions].sort(compareSessionsByActivityDesc);
  const currentIndex =
    activeSessionId === null
      ? -1
      : ordered.findIndex((session) => session.id === activeSessionId);
  if (currentIndex === -1) {
    return ordered[0].id;
  }
  if (ordered.length === 1) {
    return null;
  }
  const nextIndex =
    (currentIndex + direction + ordered.length) % ordered.length;
  return ordered[nextIndex].id;
}
