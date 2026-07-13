import { compareSessionsByActivityDesc } from "@/features/chat/lib/sessionActivity";

export interface CycleSession {
  id: string;
  projectId?: string | null;
  updatedAt: string;
  lastMessageAt?: string | null;
}

export type SessionCycleDirection = 1 | -1;

/**
 * Keep cycling inside the active refreshed-navigation context.
 *
 * `undefined` means there is no project context, so all sessions remain
 * candidates (the stable-navigation behavior). `null` is the explicit loose
 * chats context and excludes sessions assigned to projects.
 */
export function getSessionCycleProjectScope(
  session: CycleSession | null,
  scopeToProject: boolean,
): string | null | undefined {
  if (!scopeToProject || !session) {
    return undefined;
  }
  return session.projectId ?? null;
}

export function scopeSessionCycleCandidates<T extends CycleSession>(
  sessions: readonly T[],
  projectId: string | null | undefined,
): T[] {
  if (projectId === undefined) {
    return [...sessions];
  }
  return sessions.filter(
    (session) => (session.projectId ?? null) === projectId,
  );
}

/**
 * Resolve the session Ctrl+Tab-style cycling should activate next.
 *
 * Sessions cycle in most-recently-active order (the sidebar/quick-switcher
 * ordering), wrapping at both ends. Selecting a session doesn't change its
 * activity timestamp, so repeated presses walk the list predictably instead
 * of ping-ponging between the two newest sessions.
 *
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
