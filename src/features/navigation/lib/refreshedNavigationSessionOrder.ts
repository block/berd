interface RefreshedNavigationSession {
  id: string;
  clientSessionId?: string | null;
  updatedAt: string;
}

interface RefreshedNavigationChatGroup {
  id: string;
  name: string;
  chatIds: string[];
}

export interface RefreshedNavigationSessionGroup<
  T extends RefreshedNavigationSession,
> {
  id: string;
  name: string;
  sessions: T[];
}

export interface RefreshedNavigationRow<T> {
  id: string;
  groupId: string | null;
  item: T;
  selectable: boolean;
  visible: boolean;
}

export type RefreshedNavigationCycleRow = Pick<
  RefreshedNavigationRow<unknown>,
  "id" | "groupId" | "selectable" | "visible"
>;

export interface RefreshedNavigationRowGroup<T> {
  id: string;
  expanded: boolean;
  items: readonly T[];
}

export function buildRefreshedNavigationRows<T>(options: {
  groups?: readonly RefreshedNavigationRowGroup<T>[];
  ungroupedItems: readonly T[];
  getId: (item: T) => string;
  isSelectable: (item: T) => boolean;
}): Array<RefreshedNavigationRow<T>> {
  const groupedRows = (options.groups ?? []).flatMap((group) =>
    group.items.map((item) => ({
      id: options.getId(item),
      groupId: group.id,
      item,
      selectable: options.isSelectable(item),
      visible: group.expanded,
    })),
  );
  return [
    ...groupedRows,
    ...options.ungroupedItems.map((item) => ({
      id: options.getId(item),
      groupId: null,
      item,
      selectable: options.isSelectable(item),
      visible: true,
    })),
  ];
}

export function resolveRefreshedNavigationCycleTarget(
  rows: readonly Pick<
    RefreshedNavigationRow<unknown>,
    "id" | "selectable" | "visible"
  >[],
  activeSessionId: string | null,
  direction: 1 | -1,
): string | null {
  const selectableRows = rows.filter((row) => row.visible && row.selectable);
  if (selectableRows.length === 0) return null;

  const activeIndex = activeSessionId
    ? rows.findIndex((row) => row.id === activeSessionId)
    : -1;
  if (activeIndex === -1) return selectableRows[0].id;

  for (let offset = 1; offset <= rows.length; offset += 1) {
    const index =
      (activeIndex + direction * offset + rows.length) % rows.length;
    const row = rows[index];
    if (row.visible && row.selectable && row.id !== activeSessionId) {
      return row.id;
    }
  }
  return null;
}

/**
 * Session ordering rendered by the refreshed navigation.
 *
 * Home-pinned chats come first, then chats are ordered by session metadata
 * update time. Keep keyboard navigation on this shared comparator so Ctrl+Tab
 * follows the rows users see in the sidebar.
 */
export function compareRefreshedNavigationSessions<
  T extends RefreshedNavigationSession,
>(pinnedSessionIds: ReadonlySet<string>, a: T, b: T): number {
  const aPinned = pinnedSessionIds.has(a.id);
  const bPinned = pinnedSessionIds.has(b.id);
  if (aPinned !== bPinned) {
    return aPinned ? -1 : 1;
  }

  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

export function orderRefreshedNavigationSessions<
  T extends RefreshedNavigationSession,
>(sessions: readonly T[], pinnedSessionIds: ReadonlySet<string>): T[] {
  return [...sessions].sort((a, b) =>
    compareRefreshedNavigationSessions(pinnedSessionIds, a, b),
  );
}

/** Resolve persisted project groups in their rendered group/chat order. */
export function groupRefreshedNavigationProjectSessions<
  T extends RefreshedNavigationSession,
>(
  sessions: readonly T[],
  groups: readonly RefreshedNavigationChatGroup[],
): {
  groups: Array<RefreshedNavigationSessionGroup<T>>;
  ungroupedSessions: T[];
} {
  if (groups.length === 0) {
    return { groups: [], ungroupedSessions: [...sessions] };
  }

  const sessionsById = new Map(
    sessions.map((session) => [session.id, session]),
  );
  const sessionsByClientId = new Map(
    sessions
      .filter((session) => session.clientSessionId)
      .map((session) => [session.clientSessionId as string, session]),
  );
  const groupedSessionIds = new Set<string>();
  const resolvedGroups = groups.map((group) => ({
    id: group.id,
    name: group.name,
    sessions: group.chatIds
      .map(
        (chatId) => sessionsById.get(chatId) ?? sessionsByClientId.get(chatId),
      )
      .filter((session): session is T => Boolean(session))
      .map((session) => {
        groupedSessionIds.add(session.id);
        if (session.clientSessionId) {
          groupedSessionIds.add(session.clientSessionId);
        }
        return session;
      }),
  }));

  return {
    groups: resolvedGroups,
    ungroupedSessions: sessions.filter(
      (session) =>
        !groupedSessionIds.has(session.id) &&
        (!session.clientSessionId ||
          !groupedSessionIds.has(session.clientSessionId)),
    ),
  };
}

export function orderRefreshedNavigationProjectSessions<
  T extends RefreshedNavigationSession,
>(
  sessions: readonly T[],
  groups: readonly RefreshedNavigationChatGroup[],
  pinnedSessionIds: ReadonlySet<string>,
): T[] {
  const ordered = orderRefreshedNavigationSessions(sessions, pinnedSessionIds);
  const grouped = groupRefreshedNavigationProjectSessions(ordered, groups);
  return [
    ...grouped.groups.flatMap((group) => group.sessions),
    ...grouped.ungroupedSessions,
  ];
}
