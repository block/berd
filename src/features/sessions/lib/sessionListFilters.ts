import type { ChatSession } from "@/features/chat/stores/chatSessionStore";

export type SessionScope = "active" | "archived";

/**
 * Sentinel project id used to filter for sessions that have no project
 * assigned. Pass it in the selected project id set alongside real ids.
 */
export const NO_PROJECT_FILTER_ID = "__none__";

/**
 * Split sessions by archive scope. Active sessions have no `archivedAt`;
 * archived sessions have one.
 */
export function filterSessionsByScope(
  sessions: ChatSession[],
  scope: SessionScope,
): ChatSession[] {
  return sessions.filter((session) =>
    scope === "archived" ? Boolean(session.archivedAt) : !session.archivedAt,
  );
}

/**
 * The list pipeline for a scope tab: archive scope first, then the project
 * filter. Anything that counts or renders a tab's contents must go through
 * this, so a tab label can never promise rows the tab would not show (an
 * "Archived (5)" label opening an empty tab when the project filter excludes
 * all five).
 */
export function selectSessionsForScope(
  sessions: ChatSession[],
  scope: SessionScope,
  projectIds: ReadonlySet<string>,
): ChatSession[] {
  return filterSessionsByProjects(
    filterSessionsByScope(sessions, scope),
    projectIds,
  );
}

/**
 * Whether one session passes a scope tab and project filter — the per-session
 * form of `selectSessionsForScope`, for admitting server-discovered search
 * results that are not in any loaded list.
 */
export function sessionMatchesScope(
  session: ChatSession,
  scope: SessionScope,
  projectIds: ReadonlySet<string>,
): boolean {
  return selectSessionsForScope([session], scope, projectIds).length > 0;
}

/**
 * Filter sessions to those whose `projectId` is in `projectIds`.
 *
 * - An empty set means "no filter": all sessions pass through.
 * - `NO_PROJECT_FILTER_ID` in the set matches sessions with no project.
 */
export function filterSessionsByProjects(
  sessions: ChatSession[],
  projectIds: ReadonlySet<string>,
): ChatSession[] {
  if (projectIds.size === 0) {
    return sessions;
  }
  return sessions.filter((session) => {
    if (session.projectId) {
      return projectIds.has(session.projectId);
    }
    return projectIds.has(NO_PROJECT_FILTER_ID);
  });
}
