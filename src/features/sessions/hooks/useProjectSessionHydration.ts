import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";

/**
 * Upper bound on page requests issued per app session while hydrating
 * projects. Guards against pathological paging when a project owns no
 * sessions at all: without a server-side project filter we can only discover
 * that by walking to the end of the list, which this cap keeps bounded.
 * Failed pages retry separately, with backoff, up to consecutive and lifetime
 * failure limits.
 */
const MAX_PROJECT_HYDRATION_PAGES = 40;

/** Upper bound on consecutive failed page attempts before hydration stops. */
const MAX_PROJECT_HYDRATION_FAILURES = 5;

/** Upper bound on total failed attempts per app session, across refreshes. */
const MAX_PROJECT_HYDRATION_LIFETIME_FAILURES = 15;

/** Base delay between retries after a failed page; doubles per failure. */
const PROJECT_HYDRATION_RETRY_BASE_MS = 2_000;

interface ProjectSessionHydrationAccounting {
  attemptedKeys: Set<string>;
  /** Page requests issued this app session; bounds total background paging.
   *  Incremented synchronously at issue time so a burst of merged pages
   *  cannot slip extra requests past the cap. */
  issuedPages: number;
  consecutiveFailures: number;
  /** Failed attempts this app session; refresh-resistant companion to the
   *  consecutive-failure breaker so a sustained outage cannot re-arm retries
   *  on every periodic reload. */
  lifetimeFailures: number;
  /** Epoch ms when a backoff retry becomes due; 0 when no retry is pending. */
  retryNotBefore: number;
  /** Last store sessionListReloadCount the accounting has synced with. */
  syncedReloadCount: number;
}

function createProjectSessionHydrationAccounting(): ProjectSessionHydrationAccounting {
  return {
    attemptedKeys: new Set(),
    issuedPages: 0,
    consecutiveFailures: 0,
    lifetimeFailures: 0,
    retryNotBefore: 0,
    syncedReloadCount: 0,
  };
}

// App-session lifetime accounting, so collapsing the sidebar (which unmounts
// the capability) cannot reset the page budget. Generation state syncs from
// the store's sessionListReloadCount, so refreshes that happen while no
// instance is mounted are still observed on the next mount.
let accounting = createProjectSessionHydrationAccounting();

// Page completions mutate accounting from promise continuations, which can
// settle after the issuing instance unmounted. Broadcast each change so any
// currently mounted instance re-runs its effect instead of relying on the
// (possibly dead) issuer's reducer.
const accountingListeners = new Set<() => void>();
let accountingRevision = 0;

function notifyAccountingChanged(): void {
  accountingRevision += 1;
  for (const listener of accountingListeners) listener();
}

function subscribeAccounting(listener: () => void): () => void {
  accountingListeners.add(listener);
  return () => {
    accountingListeners.delete(listener);
  };
}

/**
 * Sync accounting with the store's pagination generation. A successful
 * loadSessions() reload rewinds pagination to the first page's cursor, drops
 * in-flight load-more pages via the epoch guard, and confirms connectivity —
 * so attempted positions may be revisited and the failure breaker resets.
 */
function syncAccountingWithReloadCount(reloadCount: number): void {
  if (reloadCount === accounting.syncedReloadCount) return;
  accounting.syncedReloadCount = reloadCount;
  accounting.attemptedKeys.clear();
  accounting.consecutiveFailures = 0;
  accounting.retryNotBefore = 0;
}

/** Test-only: reset module-level hydration accounting between tests. */
export function resetProjectSessionHydrationAccounting(): void {
  accounting = createProjectSessionHydrationAccounting();
  accountingRevision = 0;
}

/**
 * Keeps paging `session/list` in the background until every sidebar project
 * has at least one of its chats loaded, pagination is exhausted, the page
 * budget is spent, or retries keep failing. Without this, projects whose
 * newest chat falls past the initially loaded slice render with zero chats.
 *
 * TODO: once the goose backend `SessionListFilters` supports a `project_id`
 * filter (tracked separately from #259 as upstream follow-up), replace this
 * page-walking hydration with per-project `session/list?projectId=X` queries.
 */
export function useProjectSessionHydration(
  enabled: boolean,
  projects: ProjectInfo[],
): void {
  const hasFetchedProjects = useProjectStore(
    (state) => state.hasFetchedProjects,
  );
  const hasHydratedSessions = useChatSessionStore(
    (state) => state.hasHydratedSessions,
  );
  const sessionPageCursor = useChatSessionStore(
    (state) => state.sessionPageCursor,
  );
  const hasMoreSessions = useChatSessionStore((state) => state.hasMoreSessions);
  const isLoadingMoreSessions = useChatSessionStore(
    (state) => state.isLoadingMoreSessions,
  );
  const sessions = useChatSessionStore((state) => state.sessions);
  const isRefreshingSessions = useChatSessionStore((state) => state.isLoading);
  const sessionListReloadCount = useChatSessionStore(
    (state) => state.sessionListReloadCount,
  );
  const loadMoreSessions = useChatSessionStore(
    (state) => state.loadMoreSessions,
  );
  // Re-runs the effect when accounting changes settle from page completions
  // (including ones issued by an instance that has since unmounted).
  const accountingTick = useSyncExternalStore(
    subscribeAccounting,
    () => accountingRevision,
  );

  // Ids of visible projects that still have no started, unarchived chat in the
  // loaded slice. Zero-message placeholder sessions (drafts, pinned
  // placeholders) do not count: the sidebar only guarantees them a row while
  // they are locally relevant, so they cannot stand in for a project's chats.
  const pendingProjectIds = useMemo(() => {
    if (!enabled || !hasFetchedProjects) return [];
    const visibleProjects = projects.filter((project) => !project.archivedAt);
    if (visibleProjects.length === 0) return [];
    const hydratedProjectIds = new Set<string>();
    for (const session of sessions) {
      if (
        session.messageCount > 0 &&
        !session.archivedAt &&
        session.projectId
      ) {
        hydratedProjectIds.add(session.projectId);
      }
    }
    return visibleProjects
      .filter((project) => !hydratedProjectIds.has(project.id))
      .map((project) => project.id)
      .sort();
  }, [enabled, hasFetchedProjects, projects, sessions]);

  const allProjectsHydrated =
    enabled && hasFetchedProjects && pendingProjectIds.length === 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `accountingTick` is bumped by page completions and backoff timers to force a re-run
  useEffect(() => {
    if (!enabled || !hasFetchedProjects || !hasHydratedSessions) return;
    if (isRefreshingSessions) return;
    syncAccountingWithReloadCount(sessionListReloadCount);
    if (allProjectsHydrated || !hasMoreSessions || isLoadingMoreSessions) {
      return;
    }
    if (accounting.issuedPages >= MAX_PROJECT_HYDRATION_PAGES) return;
    if (
      accounting.consecutiveFailures >= MAX_PROJECT_HYDRATION_FAILURES ||
      accounting.lifetimeFailures >= MAX_PROJECT_HYDRATION_LIFETIME_FAILURES
    ) {
      return;
    }
    if (Date.now() < accounting.retryNotBefore) {
      // A backoff retry is due later. Wake this mounted instance when it is;
      // each instance owns its timer so an unmount/remount cycle cannot lose
      // the shared deadline's wakeup.
      const wakeTimer = setTimeout(
        notifyAccountingChanged,
        accounting.retryNotBefore - Date.now(),
      );
      return () => clearTimeout(wakeTimer);
    }

    // Attempt each (projects, cursor) position once per pagination
    // generation; syncAccountingWithReloadCount clears the set when a
    // loadSessions() refresh rewinds the cursor.
    const hydrationKey = [
      pendingProjectIds.join(","),
      sessionPageCursor ?? "__initial__",
    ].join("|");
    if (accounting.attemptedKeys.has(hydrationKey)) return;
    accounting.attemptedKeys.add(hydrationKey);
    accounting.issuedPages += 1;

    // loadMoreSessions reports the page's exact outcome. Only "failed" trips
    // the breakers; skipped/superseded pages relinquish their position so the
    // next effect run can retry them.
    void loadMoreSessions().then((outcome) => {
      syncAccountingWithReloadCount(
        useChatSessionStore.getState().sessionListReloadCount,
      );
      if (outcome === "applied") {
        accounting.consecutiveFailures = 0;
        accounting.retryNotBefore = 0;
        return;
      }
      accounting.attemptedKeys.delete(hydrationKey);
      if (outcome === "superseded") {
        // A refresh dropped this page via the epoch guard; the sync above
        // reset generation state, and the next effect run re-issues from the
        // current cursor. Not a failure.
        notifyAccountingChanged();
        return;
      }
      if (outcome === "skipped") {
        // Another page is in flight; its completion re-runs this effect and
        // retries the position. Not a failure.
        notifyAccountingChanged();
        return;
      }
      accounting.consecutiveFailures += 1;
      accounting.lifetimeFailures += 1;
      if (accounting.consecutiveFailures >= MAX_PROJECT_HYDRATION_FAILURES) {
        notifyAccountingChanged();
        return;
      }
      accounting.retryNotBefore =
        Date.now() +
        PROJECT_HYDRATION_RETRY_BASE_MS *
          2 ** (accounting.consecutiveFailures - 1);
      // Re-run the effect so the guard above schedules this instance's
      // wake timer for the deadline (or retries immediately).
      notifyAccountingChanged();
    });
    // accountingTick retriggers this effect when page-completion bookkeeping
    // lands or a backoff wake timer fires.
  }, [
    accountingTick,
    allProjectsHydrated,
    enabled,
    hasFetchedProjects,
    hasHydratedSessions,
    hasMoreSessions,
    isLoadingMoreSessions,
    isRefreshingSessions,
    loadMoreSessions,
    pendingProjectIds,
    sessionListReloadCount,
    sessionPageCursor,
  ]);
}
