import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useShallow } from "zustand/react/shallow";
import { History } from "lucide-react";
import { IconCheck, IconCopy, IconUpload, IconX } from "@tabler/icons-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  sessionActivityAt,
  sessionNeedsWindowHandoff,
} from "@/features/chat/lib/sessionActivity";
import { getDisplaySessionTitle } from "@/features/chat/lib/sessionTitle";
import {
  focusSessionWindow,
  openSessionWindow,
} from "@/features/chat/lib/sessionWindowCommands";
import { useSessionWindowSupport } from "@/features/chat/hooks/useSessionWindowSupport";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { useSetTopBarActions } from "@/app/contexts/TopBarActionsContext";
import { cn } from "@/shared/lib/cn";
import { BottomFade } from "@/shared/ui/BottomFade";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { PageHeaderButton } from "@/shared/ui/page-header-button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import type { SessionAction } from "@/features/sessions/lib/sessionSelection";
import { SearchBar } from "@/shared/ui/SearchBar";
import { ToastActionButton } from "@/shared/ui/sonner";
import { Spinner } from "@/shared/ui/spinner";
import { SessionCard } from "./SessionCard";
import { acpSessionToChatSession } from "@/features/chat/lib/acpSessionMapping";
import { groupSessionsByDate } from "../lib/groupSessionsByDate";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import {
  getVisibleSessions,
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { selectSessions } from "@/features/chat/stores/chatSessionSelectors";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { selectLocalMessageCountsBySession } from "@/features/chat/stores/chatSelectors";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { selectProjects } from "@/features/projects/stores/projectSelectors";
import {
  acpExportSession,
  acpImportSession,
  type AcpSessionInfo,
} from "@/shared/api/acp";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { exportSessionAction } from "../lib/exportSessionAction";
import { saveExportedSessionFiles } from "@/shared/api/system";
import { usePinBatchToHome } from "@/features/home/hooks/usePinToHomeWidget";
import { getPinnedHomeChatSessionIds } from "@/features/home/lib/pinnedHomeChats";
import { useHomeWidgetStore } from "@/features/home/stores/homeWidgetStore";
import { defaultExportFilename, downloadJson } from "../lib/exportSession";
import {
  areSetsEqual,
  normalizeSelectedSessionIds,
  toggleSessionSelection as getToggledSessionSelection,
} from "../lib/sessionSelection";
import { useBulkSessionActions } from "../hooks/useBulkSessionActions";
import { useForkSession } from "../hooks/useForkSession";
import { useSessionSearch } from "../hooks/useSessionSearch";
import {
  selectSessionsForScope,
  sessionMatchesScope,
  type SessionScope,
} from "../lib/sessionListFilters";
import {
  SessionListControls,
  type SessionListView,
} from "./SessionListControls";
import { SessionSearchEmptyState } from "./SessionSearchEmptyState";
import { SessionSearchStatus } from "./SessionSearchStatus";
import { SessionTimelineScrubber } from "./SessionTimelineScrubber";
import {
  flattenFlatSessionRows,
  flattenGroupedSessionRows,
  type FlatSessionRow,
  type GroupedSessionRow,
} from "../lib/flattenSessionRows";
import { useGridColumnCount } from "../hooks/useGridColumnCount";
import type { SessionSearchDisplayResult } from "../lib/buildSessionSearchResults";

// List view: one session per row, automations-style full-width card rows.
// Grid view: compact vertical cards, three columns max.
const SESSION_VIEW_COLS = {
  list: "grid grid-cols-1",
  grid: "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3",
} as const;

const SESSION_VIEW_STORAGE_KEY = "sessions.history.view";

function readStoredView(): SessionListView {
  try {
    return window.localStorage.getItem(SESSION_VIEW_STORAGE_KEY) === "grid"
      ? "grid"
      : "list";
  } catch {
    return "list";
  }
}

/**
 * The one derivation of "sessions the history page shows": started sessions,
 * narrowed to the scope tab and project filter. Both the rendered list and the
 * search sweep targets go through this. They must agree on "started" in
 * particular — a session whose only activity is a queued message renders as a
 * row, so sweeping a different set would leave a visible row unsearched and
 * make the "n of m" progress disagree with the screen.
 */
function selectHistorySessions(
  sessions: ChatSession[],
  localMessageCounts: Record<string, number>,
  scope: SessionScope,
  selectedProjectIds: ReadonlySet<string>,
): ChatSession[] {
  return selectSessionsForScope(
    getVisibleSessions(sessions, localMessageCounts),
    scope,
    selectedProjectIds,
  );
}

interface SessionHistoryViewProps {
  onSelectSession?: (sessionId: string) => void;
  onSelectSearchResult?: (
    sessionId: string,
    messageId?: string,
    query?: string,
    session?: ChatSession,
  ) => void;
  onRenameChat?: (sessionId: string, nextTitle: string) => void;
  onArchiveChat?: SessionAction;
}

const LOAD_MORE_VIEWPORT_THRESHOLD_RATIO = 0.75;
const MAX_APP_IMPORT_FILE_BYTES = 15 * 1024 * 1024;

type ImportPhase = "reading" | "importing" | "refreshing";

type ImportNotice =
  | {
      kind: "loading";
      phase: ImportPhase;
      fileName: string;
      fileSize: number;
    }
  | {
      kind: "success";
      sessionId: string;
      title: string;
      messageCount: number;
    }
  | {
      kind: "error";
      fileName: string;
      message: string;
      command?: string;
    };

function formatImportFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shellQuote(value: string): string {
  return `"${value.replace(/["\\$`]/g, "\\$&")}"`;
}

function isAbsoluteImportPath(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(path)
  );
}

function importCommandForFile(file: File): string | undefined {
  const path =
    "path" in file && typeof file.path === "string" ? file.path : file.name;
  if (!isAbsoluteImportPath(path)) {
    return undefined;
  }
  return `goose session import ${shellQuote(path)}`;
}

function importedSessionTitle(
  imported: AcpSessionInfo,
  defaultSessionTitle: string,
): string {
  return imported.title
    ? getDisplaySessionTitle(imported.title, defaultSessionTitle)
    : defaultSessionTitle;
}

function formatImportErrorMessage({
  disconnectedMessage,
  error,
  fallback,
}: {
  disconnectedMessage: string;
  error: unknown;
  fallback: string;
}): string {
  const message = formatAcpErrorMessage(error, fallback);
  if (!/\bacp connection closed\b/i.test(message)) {
    return message;
  }

  return disconnectedMessage;
}

function isNearLoadMoreThreshold(scrollElement: HTMLDivElement): boolean {
  if (scrollElement.clientHeight <= 0) {
    return false;
  }

  const remainingScroll =
    scrollElement.scrollHeight -
    scrollElement.scrollTop -
    scrollElement.clientHeight;
  const threshold =
    scrollElement.clientHeight * LOAD_MORE_VIEWPORT_THRESHOLD_RATIO;
  return remainingScroll <= threshold;
}

export function SessionHistoryView({
  onSelectSession,
  onSelectSearchResult,
  onRenameChat,
  onArchiveChat,
}: SessionHistoryViewProps) {
  const { t, i18n } = useTranslation(["sessions", "common"]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null,
  );
  const pageContentRef = useRef<HTMLDivElement>(null);
  const columnProbeRef = useRef<HTMLDivElement>(null);
  const virtualListRef = useRef<HTMLDivElement>(null);
  const [virtualListElement, setVirtualListElementState] =
    useState<HTMLDivElement | null>(null);
  const [listScrollMargin, setListScrollMargin] = useState(0);
  const viewportLoadCheckTimerRef = useRef<number | null>(null);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [importNotice, setImportNotice] = useState<ImportNotice | null>(null);
  const [copiedImportCommand, setCopiedImportCommand] = useState(false);
  const sessions = useChatSessionStore(selectSessions);
  const localMessageCountsBySession = useChatStore(
    useShallow(selectLocalMessageCountsBySession),
  );
  const loadSessions = useChatSessionStore((s) => s.loadSessions);
  const hasMoreSessions = useChatSessionStore((s) => s.hasMoreSessions);
  const isLoadingMoreSessions = useChatSessionStore(
    (s) => s.isLoadingMoreSessions,
  );
  const loadMoreSessions = useChatSessionStore((s) => s.loadMoreSessions);
  const addSession = useChatSessionStore((s) => s.addSession);
  const removeSession = useChatSessionStore((s) => s.removeSession);
  const sessionWindowSupport = useSessionWindowSupport();
  const isMultiWindowEnabled = sessionWindowSupport.supported;
  const openSessions = useSessionWindowStore((s) => s.openSessions);
  const loadMoreInFlightRef = useRef(false);
  const [scope, setScope] = useState<SessionScope>("active");
  const [view, setView] = useState<SessionListView>(readStoredView);
  const handleViewChange = useCallback((nextView: SessionListView) => {
    setView(nextView);
    try {
      window.localStorage.setItem(SESSION_VIEW_STORAGE_KEY, nextView);
    } catch {
      // localStorage may be unavailable; the toggle still works in-session.
    }
  }, []);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  // Counted through the same pipeline the Archived tab renders, so the label
  // can never promise rows the tab would not show.
  const archivedCount = useMemo(
    () =>
      selectHistorySessions(
        sessions,
        localMessageCountsBySession,
        "archived",
        selectedProjectIds,
      ).length,
    [localMessageCountsBySession, selectedProjectIds, sessions],
  );
  const activeSessions = useMemo(
    () =>
      selectHistorySessions(
        sessions,
        localMessageCountsBySession,
        scope,
        selectedProjectIds,
      ),
    [localMessageCountsBySession, scope, selectedProjectIds, sessions],
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectedCount = selectedSessionIds.size;
  const clearSelection = useCallback(() => {
    setSelectedSessionIds(new Set());
  }, []);
  useEffect(() => {
    if (selectedCount === 0) return;
    const handleMouseDown = (event: MouseEvent) => {
      const container = scrollRef.current;
      const target = event.target as Node | null;
      if (!container || !target || !container.contains(target)) return;
      if ((target as Element).closest?.("[data-session-card]")) return;
      clearSelection();
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [clearSelection, selectedCount]);
  const reportBulkFailure = useCallback(
    (failedCount: number) => {
      toast.error(
        t("common:bulkActions.failed", {
          count: failedCount,
          displayCount: failedCount,
        }),
      );
    },
    [t],
  );
  const {
    applySelectionAction,
    archiveConfirmOpen,
    archiveSelectionCount,
    confirmArchiveSelected,
    isApplyingSelectionAction,
    requestArchiveSelected,
    setArchiveConfirmOpen,
  } = useBulkSessionActions({
    selectedSessionIds,
    onComplete: clearSelection,
    onFailure: reportBulkFailure,
  });

  const getPersonaName = useCallback(
    (personaId: string) =>
      useAgentStore.getState().getPersonaById(personaId)?.displayName,
    [],
  );

  const projects = useProjectStore(selectProjects);
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );

  const getProjectName = useCallback(
    (projectId: string) => projectsById.get(projectId)?.name,
    [projectsById],
  );

  const getProjectColor = useCallback(
    (projectId: string) => projectsById.get(projectId)?.color,
    [projectsById],
  );

  const getProjectIcon = useCallback(
    (projectId: string) => projectsById.get(projectId)?.icon,
    [projectsById],
  );

  const getWorkingDir = useCallback(
    (projectId: string) => projectsById.get(projectId)?.workingDirs[0],
    [projectsById],
  );

  const resolvers = useMemo(
    () => ({ getPersonaName, getProjectName }),
    [getPersonaName, getProjectName],
  );
  const defaultSessionTitle = t("common:session.defaultTitle");
  const getDisplayTitle = useCallback(
    (session: ChatSession) =>
      getDisplaySessionTitle(session.title, defaultSessionTitle),
    [defaultSessionTitle],
  );
  const search = useSessionSearch({
    sessions: activeSessions,
    resolvers,
    locale: i18n.resolvedLanguage,
    getDisplayTitle,
    includeDiscoveredSession: (session) =>
      sessionMatchesScope(session, scope, selectedProjectIds),
  });
  const {
    error: searchError,
    isSearching,
    progress: searchProgress,
    results: searchResults,
    search: submitSearch,
    searchMore,
    setQuery: setSearchQuery,
    submittedQuery,
  } = search;

  // What the user has typed, held locally rather than pushed straight into the
  // search hook. `updateQuery` resets the hook's submitted search — query,
  // results, status — so feeding it every keystroke would blank the search
  // branch for the whole debounce window and drop the page back to unfiltered
  // browse history under a non-empty search box. Keeping the draft here means
  // the previous query's results stay on screen until the next one is
  // submitted, and the hook only ever hears queries we actually intend to run.
  const [queryDraft, setQueryDraft] = useState("");
  const trimmedQueryDraft = queryDraft.trim();
  // True while the box holds an edit we have not submitted yet. The status line
  // uses it to stop reporting the old query's result count as if it still
  // described what is typed.
  const isSearchPending =
    trimmedQueryDraft.length > 0 && trimmedQueryDraft !== submittedQuery;

  const runSearch = useCallback(
    (nextQuery: string) => {
      const trimmed = nextQuery.trim();
      if (!trimmed) {
        setSearchQuery("");
        return;
      }
      setSearchQuery(trimmed);
      void submitSearch(trimmed);
    },
    [setSearchQuery, submitSearch],
  );

  // Search-as-you-type: submit a beat after typing pauses. Enter in the
  // SearchBar still submits immediately. An emptied box clears at once — there
  // is no pending query worth protecting, and waiting would leave a stale
  // search on screen with nothing in the input to explain it.
  useEffect(() => {
    if (!trimmedQueryDraft) {
      setSearchQuery("");
      return;
    }
    if (trimmedQueryDraft === submittedQuery) return;
    const timer = window.setTimeout(() => {
      runSearch(trimmedQueryDraft);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [runSearch, setSearchQuery, submittedQuery, trimmedQueryDraft]);

  // A scope or project-filter change swaps out the session set behind a query
  // that is already on screen — including via the empty state's own "Clear
  // filters" and "Search archived" buttons, which move nothing but these two.
  // The debounce effect above cannot cover it: the query text is unchanged, so
  // it bails on `trimmed === submittedQuery` and the stale "no matches" state
  // survives the tab flip. Re-submitting the same query lands in the hook's
  // `resweep` mode, which keeps still-matching rows on screen while the new set
  // is swept. Keyed on the filters rather than on the session list so neither a
  // fresh submit (filters unchanged) nor background pagination (already swept
  // page-by-page through `searchMore`) fires a duplicate full sweep.
  const filterSweepKey = useMemo(
    () => `${scope}\n${[...selectedProjectIds].sort().join(",")}`,
    [scope, selectedProjectIds],
  );
  const sweptFilterKeyRef = useRef(filterSweepKey);
  useEffect(() => {
    if (!submittedQuery) {
      // Nothing on screen to invalidate; adopt the filters so a change made
      // before searching does not queue a resweep for the next query.
      sweptFilterKeyRef.current = filterSweepKey;
      return;
    }
    if (sweptFilterKeyRef.current === filterSweepKey) return;
    sweptFilterKeyRef.current = filterSweepKey;
    void submitSearch();
  }, [filterSweepKey, submitSearch, submittedQuery]);

  const getLoadedActiveSessions = useCallback(() => {
    const state = useChatSessionStore.getState();
    // Read through the same selector the rendered list uses (queued messages
    // included), not raw `messagesBySession`: a session visible only through a
    // queued message must be swept, not just rendered.
    const localMessageCounts = selectLocalMessageCountsBySession(
      useChatStore.getState(),
    );
    return selectHistorySessions(
      state.sessions,
      localMessageCounts,
      scope,
      selectedProjectIds,
    );
  }, [scope, selectedProjectIds]);

  // The post-pagination sweep, reached through a ref (like
  // `loadNextPageIfNeededRef` below) so it is resolved when the page lands
  // rather than captured when the load started. A scope or project change
  // mid-flight re-submits the query under a new request id, which makes the
  // `searchMore` this callback had closed over a no-op: the page that just
  // arrived would be rendered but never swept, and nothing later repairs it —
  // the viewport need not move again, least of all when that was the last page.
  const sweepLoadedSessions = useCallback(async () => {
    // Re-read rather than trusting a pre-await snapshot: by now the search may
    // have been cleared entirely, in which case there is nothing to sweep for.
    if (!submittedQuery) return;
    await searchMore(getLoadedActiveSessions());
  }, [getLoadedActiveSessions, searchMore, submittedQuery]);
  const sweepLoadedSessionsRef = useRef(sweepLoadedSessions);

  useEffect(() => {
    sweepLoadedSessionsRef.current = sweepLoadedSessions;
  }, [sweepLoadedSessions]);

  const loadNextPageIfNeeded = useCallback(async () => {
    if (
      !hasMoreSessions ||
      isLoadingMoreSessions ||
      (Boolean(submittedQuery) && isSearching) ||
      loadMoreInFlightRef.current
    ) {
      return;
    }

    // The latch is released in `finally`, so a rejected page load or sweep
    // still re-arms pagination. It has no timeout escape: if one of these
    // promises never settles, pagination stays parked until the next mount.
    // That is deliberate — a timeout would race a slow-but-live page load and
    // double-fetch it — and safe, since both calls own their own error paths.
    loadMoreInFlightRef.current = true;
    try {
      await loadMoreSessions();
      await sweepLoadedSessionsRef.current();
    } finally {
      loadMoreInFlightRef.current = false;
    }
  }, [
    hasMoreSessions,
    isLoadingMoreSessions,
    isSearching,
    loadMoreSessions,
    submittedQuery,
  ]);
  const loadNextPageIfNeededRef = useRef(loadNextPageIfNeeded);

  useEffect(() => {
    loadNextPageIfNeededRef.current = loadNextPageIfNeeded;
  }, [loadNextPageIfNeeded]);

  const checkViewportForNextPage = useCallback(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement || !isNearLoadMoreThreshold(scrollElement)) {
      return;
    }

    void loadNextPageIfNeededRef.current();
  }, []);

  const scheduleViewportLoadCheck = useCallback(() => {
    if (typeof window === "undefined") {
      checkViewportForNextPage();
      return;
    }

    if (viewportLoadCheckTimerRef.current !== null) {
      window.clearTimeout(viewportLoadCheckTimerRef.current);
    }

    viewportLoadCheckTimerRef.current = window.setTimeout(() => {
      viewportLoadCheckTimerRef.current = null;
      checkViewportForNextPage();
    }, 0);
  }, [checkViewportForNextPage]);

  useEffect(
    () => () => {
      if (
        typeof window !== "undefined" &&
        viewportLoadCheckTimerRef.current !== null
      ) {
        window.clearTimeout(viewportLoadCheckTimerRef.current);
      }
    },
    [],
  );

  const handleScroll = useCallback(() => {
    checkViewportForNextPage();
  }, [checkViewportForNextPage]);

  const getVirtualListScrollMargin = useCallback(
    (node: HTMLDivElement | null = virtualListRef.current) => {
      const scrollElement = scrollRef.current;
      if (!node || !scrollElement) {
        return 0;
      }

      return (
        node.getBoundingClientRect().top -
        scrollElement.getBoundingClientRect().top +
        scrollElement.scrollTop
      );
    },
    [],
  );
  const updateListScrollMargin = useCallback(() => {
    setListScrollMargin(getVirtualListScrollMargin());
    scheduleViewportLoadCheck();
  }, [getVirtualListScrollMargin, scheduleViewportLoadCheck]);
  const setVirtualListElement = useCallback(
    (node: HTMLDivElement | null) => {
      virtualListRef.current = node;
      setVirtualListElementState(node);
      setListScrollMargin(getVirtualListScrollMargin(node));
    },
    [getVirtualListScrollMargin],
  );

  useEffect(() => {
    updateListScrollMargin();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateListScrollMargin);
      return () => window.removeEventListener("resize", updateListScrollMargin);
    }

    const observer = new ResizeObserver(updateListScrollMargin);
    const scrollElement = scrollRef.current;
    const pageContentElement = pageContentRef.current;

    if (scrollElement) observer.observe(scrollElement);
    if (pageContentElement) observer.observe(pageContentElement);
    if (virtualListElement) observer.observe(virtualListElement);

    window.addEventListener("resize", updateListScrollMargin);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateListScrollMargin);
    };
  }, [updateListScrollMargin, virtualListElement]);

  const dateGroups = useMemo(
    () =>
      groupSessionsByDate(activeSessions, {
        locale: i18n.resolvedLanguage,
        todayLabel: t("dateGroups.today"),
        yesterdayLabel: t("dateGroups.yesterday"),
      }),
    [activeSessions, i18n.resolvedLanguage, t],
  );
  const probedColumns = useGridColumnCount(columnProbeRef);
  const columns = view === "grid" ? probedColumns : 1;
  const groupedRows = useMemo(
    () => flattenGroupedSessionRows(dateGroups, columns),
    [columns, dateGroups],
  );
  const groupedVirtualizer = useVirtualizer({
    count: groupedRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      // Headers are not all the same height: the first one is `pt-1` (~32px)
      // while later ones carry `pt-8` to separate groups (~60px). One estimate
      // for both over-guessed row 0 by ~28px, which showed up as a wider gap
      // under "Today" than under every later date.
      if (groupedRows[index]?.kind === "header") {
        return index === 0 ? 32 : 60;
      }
      return view === "grid" ? 152 : 118;
    },
    getItemKey: (index) => groupedRows[index]?.key ?? index,
    measureElement:
      typeof window !== "undefined" &&
      navigator.userAgent.indexOf("Firefox") === -1
        ? (element) => element?.getBoundingClientRect().height
        : undefined,
    overscan: 5,
    scrollMargin: listScrollMargin,
  });

  const groupedVirtualItems = groupedVirtualizer.getVirtualItems();
  const timelineMarkers = useMemo(() => {
    // Weight each marker by its group's session count so busy recent dates
    // own more of the rail (header keys are `h:${label}`).
    const countsByLabel = new Map(
      dateGroups.map((group) => [group.label, group.sessions.length]),
    );
    return groupedRows.flatMap((row, index) =>
      row.kind === "header"
        ? [
            {
              key: row.key,
              label: row.label,
              index,
              count: countsByLabel.get(row.label) ?? 1,
            },
          ]
        : [],
    );
  }, [dateGroups, groupedRows]);
  // The date group currently at (or above) the top of the viewport: the last
  // header at or before the first genuinely visible row.
  //
  // `getVirtualItems()` leads with `overscan` rows that are rendered but sit
  // above the viewport, so its first entry is not the row the user is looking
  // at — reading it made the highlighted date (and the scrubber's
  // `aria-valuetext`) lag a section behind the screen. Measure against the
  // scroll offset instead: the first row whose end has passed the viewport top
  // is the first one actually on screen. Row `start`/`end` already include the
  // virtualizer's `scrollMargin`, which is the same space `scrollOffset` is
  // reported in, so the two compare directly.
  const groupedScrollOffset = groupedVirtualizer.scrollOffset ?? 0;
  const activeTimelineKey = useMemo(() => {
    const firstVisible = groupedVirtualItems.find(
      (item) => item.end > groupedScrollOffset,
    );
    const firstVisibleIndex = firstVisible?.index;
    if (firstVisibleIndex === undefined) return undefined;
    let active: string | undefined;
    for (const marker of timelineMarkers) {
      if (marker.index > firstVisibleIndex) break;
      active = marker.key;
    }
    return active ?? timelineMarkers[0]?.key;
  }, [groupedScrollOffset, groupedVirtualItems, timelineMarkers]);
  const jumpToTimelineIndex = useCallback(
    (index: number) => {
      groupedVirtualizer.scrollToIndex(index, { align: "start" });
    },
    [groupedVirtualizer],
  );
  // Results are only as current as the last sweep, but membership can change
  // under them without touching the query, the scope, or the project filter —
  // restoring a session from the Archived tab is exactly that. Gate loaded rows
  // on the live session set so a row that no longer belongs cannot linger
  // (still offering its Restore action) until something else triggers a
  // resweep. Server-discovered sessions are not in the loaded set; the hook
  // already admitted them through the live scope/project filters, and an
  // archive/restore flip lands in the store (loaded) or in the next resweep.
  const activeSessionIds = useMemo(
    () => new Set(activeSessions.map((session) => session.id)),
    [activeSessions],
  );
  const allSessionIds = useMemo(
    () => new Set(sessions.map((session) => session.id)),
    [sessions],
  );
  const visibleSearchResults = useMemo(
    () =>
      searchResults.filter((result) => {
        if (activeSessionIds.has(result.session.id)) return true;
        // The store knows this session but the current scope excludes it
        // (wrong tab, wrong project, archived under the Active tab): the
        // server-discovered copy must not smuggle it back in.
        return !allSessionIds.has(result.session.id);
      }),
    [activeSessionIds, allSessionIds, searchResults],
  );
  const searchRows = useMemo(
    () => flattenFlatSessionRows(visibleSearchResults, columns),
    [columns, visibleSearchResults],
  );
  const searchVirtualizer = useVirtualizer({
    count: searchRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (view === "grid" ? 170 : 130),
    getItemKey: (index) => searchRows[index]?.key ?? index,
    measureElement:
      typeof window !== "undefined" &&
      navigator.userAgent.indexOf("Firefox") === -1
        ? (element) => element?.getBoundingClientRect().height
        : undefined,
    overscan: 5,
    scrollMargin: listScrollMargin,
  });
  // Row keys survive a list<->grid toggle (`r:${label}:${firstSessionId}` has
  // no view component), so without this the virtualizer would apply heights it
  // measured for list rows to grid rows and vice versa — leaving gaps or
  // overlap until each row happens to be re-measured. `measure()` drops the
  // cached sizes so every row re-measures against the new template.
  // Read through refs so the effect fires on a view change only. Keying it on
  // the virtualizer instances would re-run it on any render that hands back
  // fresh ones, throwing away good measurements.
  const groupedVirtualizerRef = useRef(groupedVirtualizer);
  groupedVirtualizerRef.current = groupedVirtualizer;
  const searchVirtualizerRef = useRef(searchVirtualizer);
  searchVirtualizerRef.current = searchVirtualizer;
  const isFirstViewRenderRef = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: view is the intentional trigger; the virtualizers are read through refs so a fresh instance never re-fires this.
  useEffect(() => {
    if (isFirstViewRenderRef.current) {
      // Nothing measured yet on mount; skip the redundant invalidation.
      isFirstViewRenderRef.current = false;
      return;
    }
    groupedVirtualizerRef.current.measure();
    searchVirtualizerRef.current.measure();
  }, [view]);

  const viewportLoadCheckState = useMemo(
    () => ({
      activeSessionCount: activeSessions.length,
      groupedRowCount: groupedRows.length,
      hasMoreSessions,
      searchRowCount: searchRows.length,
      sessionCount: sessions.length,
      submittedQuery,
    }),
    [
      activeSessions.length,
      groupedRows.length,
      hasMoreSessions,
      searchRows.length,
      sessions.length,
      submittedQuery,
    ],
  );

  useEffect(() => {
    if (!viewportLoadCheckState.hasMoreSessions) {
      return;
    }

    scheduleViewportLoadCheck();
  }, [scheduleViewportLoadCheck, viewportLoadCheckState]);

  const handleArchive = useCallback(
    async (sessionId: string) => {
      if (onArchiveChat) {
        return onArchiveChat(sessionId);
      }

      void useChatSessionStore
        .getState()
        .archiveSession(sessionId)
        .catch((err: unknown) =>
          console.error("Failed to archive session in backend:", err),
        );
    },
    [onArchiveChat],
  );

  // The Archived tab is a first-class destination here, so its rows need the
  // way back out. Resolves to an outcome rather than swallowing the result:
  // the bulk path can only hold its pending state and count failed rows if the
  // action it awaits reports what the backend actually did. Failures are still
  // logged here, and the store rolls the row back itself.
  const restoreSession = useCallback(async (sessionId: string) => {
    try {
      await useChatSessionStore.getState().unarchiveSession(sessionId);
      return { ok: true };
    } catch (err: unknown) {
      console.error("Failed to restore session in backend:", err);
      return { ok: false };
    }
  }, []);

  // Single row: optimistic, same as archiving — the row leaves the list at
  // once and a late failure rolls it back.
  const handleUnarchive = useCallback(
    (sessionId: string) => {
      void restoreSession(sessionId);
    },
    [restoreSession],
  );

  // Restore for a multi-row selection, through the same bulk workflow Archive
  // uses (pending state, per-row failure reporting, selection cleared on
  // completion). No confirm step: unlike archiving, restoring is reversible
  // from the row it lands on.
  const handleUnarchiveSelected = useCallback(() => {
    void applySelectionAction(restoreSession);
  }, [applySelectionAction, restoreSession]);

  const handleFork = useForkSession({ onForked: onSelectSession });

  const toggleSessionSelection = useCallback(
    (sessionId: string, selected: boolean) => {
      setSelectedSessionIds((current) =>
        getToggledSessionSelection({ current, sessionId, selected }),
      );
    },
    [],
  );

  useEffect(() => {
    setSelectedSessionIds((current) => {
      const activeIds = new Set(activeSessions.map((session) => session.id));
      const next = normalizeSelectedSessionIds({
        current,
        activeSessionIds: activeIds,
      });

      return areSetsEqual(next, current) ? current : next;
    });
  }, [activeSessions]);

  const handleExport = useCallback(
    async (sessionId: string) => {
      const session = activeSessions.find((s) => s.id === sessionId);
      await exportSessionAction({
        sessionId,
        title: session?.title ?? "session",
        displayTitle: session ? getDisplayTitle(session) : defaultSessionTitle,
        onNotFound: () => removeSession(sessionId),
      });
    },
    [activeSessions, defaultSessionTitle, getDisplayTitle, removeSession],
  );

  const handleOpenInWindow = useCallback(
    (sessionId: string) => {
      const isOpenInWindow =
        sessionId in useSessionWindowStore.getState().openSessions;
      const runtime = useChatStore.getState().sessionStateById[sessionId];
      const needsHandoff = runtime ? sessionNeedsWindowHandoff(runtime) : false;
      const action = isOpenInWindow
        ? () => focusSessionWindow(sessionId)
        : () => openSessionWindow(sessionId, { handoff: needsHandoff });

      void action().catch((error) => {
        console.error(
          isOpenInWindow
            ? "Failed to focus session window:"
            : "Failed to open session window:",
          error,
        );
        toast.error(
          t(
            isOpenInWindow ? "card.focusWindowFailed" : "card.openWindowFailed",
          ),
        );
      });
    },
    [t],
  );

  const { pinBatchToHome, unpinBatchFromHome, isPinningBatch } =
    usePinBatchToHome();
  const handlePinSelectedToHome = useCallback(async () => {
    const ids = Array.from(selectedSessionIds);
    if (ids.length === 0) return;
    await pinBatchToHome("chat", ids);
    clearSelection();
  }, [clearSelection, pinBatchToHome, selectedSessionIds]);

  const handleUnpinSelectedFromHome = useCallback(() => {
    const ids = Array.from(selectedSessionIds);
    if (ids.length === 0) return;
    unpinBatchFromHome("chat", ids);
    clearSelection();
  }, [clearSelection, selectedSessionIds, unpinBatchFromHome]);

  const homeWidgetInstances = useHomeWidgetStore((state) => state.instances);
  const isSelectionPinnedToHome = useMemo(() => {
    if (selectedSessionIds.size === 0) return false;
    const pinnedIds = getPinnedHomeChatSessionIds(homeWidgetInstances);
    return [...selectedSessionIds].every((sessionId) =>
      pinnedIds.has(sessionId),
    );
  }, [homeWidgetInstances, selectedSessionIds]);

  const handleMarkSelectedRead = useCallback(() => {
    const markSessionRead = useChatStore.getState().markSessionRead;
    selectedSessionIds.forEach(markSessionRead);
    clearSelection();
  }, [clearSelection, selectedSessionIds]);

  const handleMarkSelectedUnread = useCallback(() => {
    const markSessionUnread = useChatStore.getState().markSessionUnread;
    selectedSessionIds.forEach(markSessionUnread);
    clearSelection();
  }, [clearSelection, selectedSessionIds]);

  const handleExportSelected = useCallback(async () => {
    const sessionIds = Array.from(selectedSessionIds);
    if (sessionIds.length === 0) return;

    const titleById = new Map(
      activeSessions.map((session) => [session.id, session.title ?? "session"]),
    );

    try {
      const items = await Promise.all(
        sessionIds.map(async (id) => ({
          filename: defaultExportFilename(titleById.get(id) ?? "session"),
          contents: await acpExportSession(id),
        })),
      );

      if (window.__TAURI_INTERNALS__) {
        const result = await saveExportedSessionFiles(items);
        if (!result) return;
        toast.success(
          `Exported ${result.files.length} chats to ${result.folder}`,
        );
      } else {
        for (const item of items) {
          downloadJson(item.contents, item.filename);
        }
        toast.success(`Exported ${items.length} chats`);
      }
      clearSelection();
    } catch (error) {
      console.error("Bulk export failed:", error);
      toast.error(formatAcpErrorMessage(error, "Failed to export chats"));
    }
  }, [activeSessions, clearSelection, selectedSessionIds]);

  const handleOpenImportedSession = useCallback(
    (sessionId: string) => {
      onSelectSession?.(sessionId);
    },
    [onSelectSession],
  );

  const handleImportSession = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (file.size > MAX_APP_IMPORT_FILE_BYTES) {
        setImportNotice({
          kind: "error",
          fileName: file.name,
          message: t("history.importTooLarge"),
          command: importCommandForFile(file),
        });
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
        return;
      }

      setImportNotice({
        kind: "loading",
        phase: "reading",
        fileName: file.name,
        fileSize: file.size,
      });

      let phase: ImportPhase = "reading";

      try {
        const text = await file.text();
        phase = "importing";
        setImportNotice({
          kind: "loading",
          phase,
          fileName: file.name,
          fileSize: file.size,
        });
        const imported = await acpImportSession(text);
        addSession(acpSessionToChatSession(imported));
        phase = "refreshing";
        setImportNotice({
          kind: "loading",
          phase,
          fileName: file.name,
          fileSize: file.size,
        });
        await loadSessions();

        const title = importedSessionTitle(imported, defaultSessionTitle);
        setImportNotice({
          kind: "success",
          sessionId: imported.sessionId,
          title,
          messageCount: imported.messageCount,
        });
        toast.success(t("history.importSuccess", { title }), {
          action: onSelectSession ? (
            <ToastActionButton
              onClick={() => handleOpenImportedSession(imported.sessionId)}
            >
              {t("common:actions.open")}
            </ToastActionButton>
          ) : undefined,
        });
      } catch (error) {
        const message = formatImportErrorMessage({
          disconnectedMessage: t("history.importDisconnectedError", {
            fileSize: formatImportFileSize(file.size),
            phase: t(`history.importPhaseDescription.${phase}`),
          }),
          error,
          fallback: t("history.importFailedFallback"),
        });
        console.error("Import failed:", error);
        setImportNotice({
          kind: "error",
          fileName: file.name,
          message,
          command: importCommandForFile(file),
        });
        toast.error(t("history.importFailed"), { description: message });
      } finally {
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }
    },
    [
      addSession,
      defaultSessionTitle,
      handleOpenImportedSession,
      loadSessions,
      onSelectSession,
      t,
    ],
  );

  const setTopBarActions = useSetTopBarActions();
  const isImporting = importNotice?.kind === "loading";
  const handleTriggerImport = useCallback(() => {
    if (isImporting) return;
    fileInputRef.current?.click();
  }, [isImporting]);
  const handleDismissImportNotice = useCallback(() => {
    if (!isImporting) setImportNotice(null);
  }, [isImporting]);
  const handleCopyImportCommand = useCallback(async (command: string) => {
    await navigator.clipboard.writeText(command);
    setCopiedImportCommand(true);
    window.setTimeout(() => setCopiedImportCommand(false), 1500);
  }, []);

  useEffect(() => {
    setTopBarActions(
      <PageHeaderButton
        type="button"
        onClick={handleTriggerImport}
        leftIcon={<IconUpload />}
        feedbackState={isImporting ? "loading" : "idle"}
        loadingLabel={t("history.importingButton")}
      >
        {t("common:actions.import")}
      </PageHeaderButton>,
    );
    return () => setTopBarActions(null);
  }, [setTopBarActions, t, handleTriggerImport, isImporting]);

  const handleSelectResult = useCallback(
    (sessionId: string, messageId?: string, session?: ChatSession) => {
      // Search rows go through the search-result path: discovered sessions
      // need the caller's pre-activation hydration, which `onSelectSession`
      // does not do.
      onSelectSearchResult?.(sessionId, messageId, submittedQuery, session);
    },
    [onSelectSearchResult, submittedQuery],
  );

  const renderSessionCard = useCallback(
    (
      session: ChatSession,
      options?: {
        snippet?: string;
        matchCount?: number;
        messageId?: string;
        /** Present only for search rows; distinguishes metadata hits from
         *  content hits. */
        matchType?: "metadata" | "message";
      },
    ) => {
      const isSearchResult = options?.matchType !== undefined;
      const messageId = options?.messageId;
      const isMetadataMatch = options?.matchType === "metadata";
      // Server-discovered rows are not in the session store, so store-backed
      // mutations (rename, fork, archive/restore) would silently no-op;
      // export and open work straight off the session id and stay available.
      const isHydrated = allSessionIds.has(session.id);
      // Browse cards preview the latest message text; search cards show the
      // matched snippet instead. A server-discovered content match has no
      // snippet until its corpus is exported — fall back to the session
      // preview. A metadata-only match has no content snippet to show, and
      // the preview must not pose as one.
      const snippet = isMetadataMatch
        ? undefined
        : isSearchResult
          ? options?.snippet || (session.subtitle ?? undefined)
          : (session.subtitle ?? undefined);
      return (
        <SessionCard
          key={session.id}
          id={session.id}
          title={session.title}
          updatedAt={sessionActivityAt(session)}
          personaName={
            session.personaId ? getPersonaName(session.personaId) : undefined
          }
          projectId={session.projectId ?? undefined}
          projectName={
            session.projectId ? getProjectName(session.projectId) : undefined
          }
          projectColor={
            session.projectId ? getProjectColor(session.projectId) : undefined
          }
          projectIcon={
            session.projectId ? getProjectIcon(session.projectId) : undefined
          }
          workingDir={
            session.projectId ? getWorkingDir(session.projectId) : undefined
          }
          archivedAt={session.archivedAt}
          layout={view === "grid" ? "grid" : "row"}
          snippet={snippet}
          snippetLineClamp={isSearchResult ? undefined : 1}
          matchCount={options?.matchCount}
          onSelect={
            isSearchResult
              ? () => handleSelectResult(session.id, messageId, session)
              : onSelectSession
          }
          selected={selectedSessionIds.has(session.id)}
          selectionEnabled={selectedCount > 0}
          selectionActionsDisabled={isApplyingSelectionAction}
          selectionCount={selectedCount}
          onSelectionClear={clearSelection}
          onSelectionChange={toggleSessionSelection}
          onRename={isHydrated ? onRenameChat : undefined}
          onFork={isHydrated ? handleFork : undefined}
          onArchive={isHydrated ? handleArchive : undefined}
          onUnarchive={isHydrated ? handleUnarchive : undefined}
          onUnarchiveSelected={handleUnarchiveSelected}
          onArchiveSelected={requestArchiveSelected}
          onExport={handleExport}
          onExportSelected={handleExportSelected}
          onOpenInWindow={
            isMultiWindowEnabled && !session.archivedAt
              ? handleOpenInWindow
              : undefined
          }
          isOpenInWindow={isMultiWindowEnabled && session.id in openSessions}
          onPinSelectedToHome={handlePinSelectedToHome}
          onUnpinSelectedFromHome={handleUnpinSelectedFromHome}
          isSelectionPinnedToHome={isSelectionPinnedToHome}
          isPinningSelectedToHome={isPinningBatch}
          onMarkSelectedRead={handleMarkSelectedRead}
          onMarkSelectedUnread={handleMarkSelectedUnread}
        />
      );
    },
    [
      allSessionIds,
      getPersonaName,
      getProjectColor,
      getProjectIcon,
      getProjectName,
      getWorkingDir,
      handleArchive,
      handleUnarchive,
      handleUnarchiveSelected,
      handleFork,
      requestArchiveSelected,
      clearSelection,
      handleExport,
      handleExportSelected,
      handleOpenInWindow,
      handlePinSelectedToHome,
      handleUnpinSelectedFromHome,
      isSelectionPinnedToHome,
      handleMarkSelectedRead,
      handleMarkSelectedUnread,
      isMultiWindowEnabled,
      isPinningBatch,
      handleSelectResult,
      isApplyingSelectionAction,
      onRenameChat,
      onSelectSession,
      openSessions,
      selectedCount,
      selectedSessionIds,
      toggleSessionSelection,
      view,
    ],
  );

  const renderGroupedRow = useCallback(
    (row: GroupedSessionRow, isFirstRow = false) => {
      if (row.kind === "header") {
        return (
          <h2
            className={cn(
              // 14px regular sentence case, not small caps: the rest of the
              // app does not lean on uppercase section labels.
              "px-1 pb-2 text-sm font-normal text-muted-foreground",
              // The page container already spaces the search bar from the
              // first group; only stack extra top padding between groups.
              isFirstRow ? "pt-1" : "pt-8",
            )}
          >
            {row.label}
          </h2>
        );
      }

      // Virtualized rows position absolutely, so the inter-row gap lives
      // inside the measured element as bottom padding.
      return (
        <div
          className={cn(
            SESSION_VIEW_COLS[view],
            view === "grid" ? "pb-4" : "pb-2",
          )}
        >
          {row.sessions.map((session) => renderSessionCard(session))}
        </div>
      );
    },
    [renderSessionCard, view],
  );

  const renderSearchRow = useCallback(
    (row: FlatSessionRow<SessionSearchDisplayResult>) => (
      <div
        className={cn(
          SESSION_VIEW_COLS[view],
          view === "grid" ? "pb-4" : "pb-2",
        )}
      >
        {row.items.map((result) =>
          renderSessionCard(result.session, {
            snippet: result.snippet,
            matchCount: result.matchCount,
            messageId: result.messageId,
            matchType: result.matchType,
          }),
        )}
      </div>
    ),
    [renderSessionCard, view],
  );

  const isLoadingAdditionalSessions =
    isLoadingMoreSessions || (Boolean(submittedQuery) && isSearching);
  const loadMoreStatus = isLoadingAdditionalSessions
    ? submittedQuery
      ? t("history.loadingMoreSearchResults")
      : t("history.loadingMoreSessions")
    : "";
  const setScrollNode = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    setScrollElement(node);
  }, []);

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      {!submittedQuery && (
        <SessionTimelineScrubber
          markers={timelineMarkers}
          activeKey={activeTimelineKey}
          onJump={jumpToTimelineIndex}
          hasMore={hasMoreSessions}
          onLoadOlder={() => void loadNextPageIfNeeded()}
          isLoadingOlder={isLoadingAdditionalSessions}
          className="absolute bottom-24 right-2 top-32 z-10 hidden xl:flex"
        />
      )}
      <div
        ref={setScrollNode}
        data-testid="session-history-scroll"
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-scroll [scrollbar-gutter:stable]"
      >
        <div
          ref={pageContentRef}
          className="page-transition mx-auto flex w-full max-w-5xl flex-col gap-5 px-6 pb-app-page-bottom pt-8"
        >
          <div className="flex flex-col gap-3">
            <div className="max-w-md">
              <SearchBar
                size="pill"
                value={queryDraft}
                onChange={setQueryDraft}
                onKeyDown={(event) => {
                  // Enter skips the type-ahead debounce and submits now.
                  if (event.key === "Enter") {
                    event.preventDefault();
                    runSearch(queryDraft);
                  }
                }}
                placeholder={t("history.searchPlaceholder")}
                aria-label={t("history.searchPlaceholder")}
              />
            </div>
            {submittedQuery ? (
              <SessionSearchStatus
                query={submittedQuery}
                isPending={isSearchPending}
                isSearching={isSearching}
                progress={searchProgress}
                resultCount={visibleSearchResults.length}
                error={searchError}
              />
            ) : null}
            <SessionListControls
              scope={scope}
              onScopeChange={setScope}
              archivedCount={archivedCount}
              projects={projects.map((project) => ({
                id: project.id,
                name: project.name,
                color: project.color,
                icon: project.icon,
              }))}
              selectedProjectIds={selectedProjectIds}
              onSelectedProjectIdsChange={setSelectedProjectIds}
              showNoProject
              view={view}
              onViewChange={handleViewChange}
            />
          </div>

          {importNotice && (
            <Alert
              variant="default"
              role={importNotice.kind === "loading" ? "status" : "alert"}
              aria-live="polite"
              className={cn(
                "col-span-full",
                importNotice.kind === "error" && "border-destructive/30",
              )}
            >
              {importNotice.kind === "loading" && (
                <Spinner className="size-4" aria-hidden="true" />
              )}
              <AlertTitle>
                {importNotice.kind === "loading"
                  ? t(`history.importPhase.${importNotice.phase}`)
                  : importNotice.kind === "success"
                    ? t("history.importComplete")
                    : t("history.importFailed")}
              </AlertTitle>
              <AlertDescription>
                {importNotice.kind === "loading" && (
                  <p>
                    {t("history.importProgressDescription", {
                      fileName: importNotice.fileName,
                      fileSize: formatImportFileSize(importNotice.fileSize),
                    })}
                  </p>
                )}
                {importNotice.kind === "success" && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span>
                      {t("history.importCompleteDescription", {
                        title: importNotice.title,
                        count: importNotice.messageCount,
                        displayCount: importNotice.messageCount,
                      })}
                    </span>
                    {onSelectSession && (
                      <Button
                        type="button"
                        variant="alert"
                        size="xxs"
                        onClick={() =>
                          handleOpenImportedSession(importNotice.sessionId)
                        }
                      >
                        {t("common:actions.open")}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="alert"
                      size="xxs"
                      onClick={handleDismissImportNotice}
                    >
                      {t("common:actions.close")}
                    </Button>
                  </div>
                )}
                {importNotice.kind === "error" && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pr-8 text-sm text-muted-foreground">
                    <span>
                      {t("history.importFailedDescription", {
                        fileName: importNotice.fileName,
                        message: importNotice.message,
                      })}
                    </span>
                    {importNotice.command && (
                      <>
                        <span>{t("history.importCommandIntro")}</span>
                        <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 align-middle">
                          <code className="min-w-0 truncate font-mono text-xs text-foreground">
                            {importNotice.command}
                          </code>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            aria-label={t("history.copyImportCommand")}
                            tooltip={t("history.copyImportCommand")}
                            onClick={() => {
                              if (importNotice.command) {
                                void handleCopyImportCommand(
                                  importNotice.command,
                                );
                              }
                            }}
                          >
                            {copiedImportCommand ? <IconCheck /> : <IconCopy />}
                          </Button>
                        </span>
                        <span>{t("history.importCommandRefresh")}</span>
                      </>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="absolute right-3 top-3"
                      aria-label={t("common:actions.close")}
                      tooltip={t("common:actions.close")}
                      onClick={handleDismissImportNotice}
                    >
                      <IconX />
                    </Button>
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}

          {/* Search failures are narrated by SessionSearchStatus alone. A
          second copy here meant one failed sweep rendered two error lines and
          announced both to screen readers. */}

          <div role="status" aria-live="polite" className="sr-only">
            {loadMoreStatus}
          </div>

          <div
            ref={columnProbeRef}
            data-testid="session-column-probe"
            aria-hidden="true"
            // Always probes the grid-view template (even in list view) so the
            // column count is correct the moment the user toggles to grid.
            className={cn(
              SESSION_VIEW_COLS.grid,
              "pointer-events-none invisible h-0 overflow-hidden",
            )}
          />

          {submittedQuery ? (
            visibleSearchResults.length > 0 ? (
              <div
                ref={setVirtualListElement}
                className="relative w-full"
                style={{ height: `${searchVirtualizer.getTotalSize()}px` }}
              >
                {searchVirtualizer.getVirtualItems().map((virtualRow) => {
                  const row = searchRows[virtualRow.index];
                  if (!row) return null;

                  return (
                    <div
                      key={virtualRow.key}
                      data-index={virtualRow.index}
                      ref={searchVirtualizer.measureElement}
                      className="absolute left-0 top-0 w-full"
                      style={{
                        transform: `translateY(${
                          virtualRow.start - listScrollMargin
                        }px)`,
                      }}
                    >
                      {renderSearchRow(row)}
                    </div>
                  );
                })}
              </div>
            ) : isSearching ? (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
                <History className="h-10 w-10 opacity-30" />
                <p className="text-sm font-medium">{t("history.searching")}</p>
              </div>
            ) : (
              <SessionSearchEmptyState
                query={submittedQuery}
                onClearFilters={
                  selectedProjectIds.size > 0
                    ? () => setSelectedProjectIds(new Set())
                    : undefined
                }
                onShowArchived={
                  scope === "active" && archivedCount > 0
                    ? () => setScope("archived")
                    : undefined
                }
              />
            )
          ) : dateGroups.length > 0 ? (
            <div
              ref={setVirtualListElement}
              className="relative w-full"
              style={{ height: `${groupedVirtualizer.getTotalSize()}px` }}
            >
              {groupedVirtualItems.map((virtualRow) => {
                const row = groupedRows[virtualRow.index];
                if (!row) return null;

                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={groupedVirtualizer.measureElement}
                    className="absolute left-0 top-0 w-full"
                    style={{
                      transform: `translateY(${
                        virtualRow.start - listScrollMargin
                      }px)`,
                    }}
                  >
                    {renderGroupedRow(row, virtualRow.index === 0)}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
              <History className="h-10 w-10 opacity-30" />
              <div className="text-center">
                {/* The project filter is read before the scope, because a
                filtered-out tab is not an empty one: checking the scope first
                told users their archive was empty while archived chats sat
                just outside the selected projects, with no route back. */}
                <p className="text-sm font-medium">
                  {selectedProjectIds.size > 0
                    ? t("history.emptyFiltered")
                    : scope === "archived"
                      ? t("history.emptyArchived")
                      : t("history.emptyTitle")}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {selectedProjectIds.size > 0
                    ? scope === "archived"
                      ? t("history.emptyFilteredArchivedHint")
                      : t("history.emptyFilteredHint")
                    : scope === "archived"
                      ? t("history.emptyArchivedHint")
                      : t("history.emptyHint")}
                </p>
              </div>
              {selectedProjectIds.size > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  flush
                  onClick={() => setSelectedProjectIds(new Set())}
                >
                  {t("history.emptyClearFilters")}
                </Button>
              )}
            </div>
          )}

          {hasMoreSessions && isLoadingAdditionalSessions && (
            <div className="flex justify-center pt-1 text-xs text-muted-foreground">
              {submittedQuery
                ? t("history.loadingMoreSearchResults")
                : t("history.loadingMoreSessions")}
            </div>
          )}
        </div>
      </div>
      <BottomFade
        scrollElement={scrollElement}
        className="absolute inset-x-0 bottom-0 z-10"
      />

      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleImportSession}
        className="hidden"
      />
      <ConfirmDialog
        open={archiveConfirmOpen}
        onOpenChange={setArchiveConfirmOpen}
        title={t("common:bulkActions.archiveConfirmTitle", {
          count: archiveSelectionCount,
          displayCount: archiveSelectionCount,
        })}
        description={t("common:bulkActions.archiveConfirmDescription", {
          count: archiveSelectionCount,
          displayCount: archiveSelectionCount,
        })}
        cancelLabel={t("common:actions.cancel")}
        confirmLabel={t("common:actions.archive")}
        destructive={false}
        loadingLabel={t("common:bulkActions.archiving")}
        isLoading={isApplyingSelectionAction}
        onConfirm={() => confirmArchiveSelected(handleArchive)}
      />
    </div>
  );
}
