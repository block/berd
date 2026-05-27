import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { History } from "lucide-react";
import { IconUpload } from "@tabler/icons-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { getDisplaySessionTitle } from "@/features/chat/lib/sessionTitle";
import { useSetTopBarActions } from "@/app/contexts/TopBarActionsContext";
import { cn } from "@/shared/lib/cn";
import { BottomFade } from "@/shared/ui/BottomFade";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { SearchBar } from "@/shared/ui/SearchBar";
import { SessionCard } from "./SessionCard";
import { groupSessionsByDate } from "../lib/groupSessionsByDate";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import {
  getVisibleSessions,
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { selectSessions } from "@/features/chat/stores/chatSessionSelectors";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { selectMessagesBySession } from "@/features/chat/stores/chatSelectors";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { selectProjects } from "@/features/projects/stores/projectSelectors";
import {
  acpDuplicateSession,
  acpExportSession,
  acpImportSession,
} from "@/shared/api/acp";
import { saveExportedSessionFile } from "@/shared/api/system";
import { defaultExportFilename, downloadJson } from "../lib/exportSession";
import {
  areSetsEqual,
  normalizeSelectedSessionIds,
  toggleSessionSelection as getToggledSessionSelection,
} from "../lib/sessionSelection";
import { useBulkSessionActions } from "../hooks/useBulkSessionActions";
import { useSessionSearch } from "../hooks/useSessionSearch";
import {
  flattenFlatSessionRows,
  flattenGroupedSessionRows,
  type FlatSessionRow,
  type GroupedSessionRow,
} from "../lib/flattenSessionRows";
import { useGridColumnCount } from "../hooks/useGridColumnCount";
import type { SessionSearchDisplayResult } from "../lib/buildSessionSearchResults";

const SESSION_GRID_COLS =
  "grid grid-cols-1 gap-x-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-[repeat(4,minmax(0,235px))] 2xl:grid-cols-[repeat(5,minmax(0,235px))] xl:justify-evenly";

interface SessionHistoryViewProps {
  onSelectSession?: (sessionId: string) => void;
  onSelectSearchResult?: (
    sessionId: string,
    messageId?: string,
    query?: string,
  ) => void;
  onRenameChat?: (sessionId: string, nextTitle: string) => void;
  onArchiveChat?: (sessionId: string) => void | Promise<void>;
}

const LOAD_MORE_VIEWPORT_THRESHOLD_RATIO = 0.75;

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
  const sessions = useChatSessionStore(selectSessions);
  const messagesBySession = useChatStore(selectMessagesBySession);
  const loadSessions = useChatSessionStore((s) => s.loadSessions);
  const hasMoreSessions = useChatSessionStore((s) => s.hasMoreSessions);
  const isLoadingMoreSessions = useChatSessionStore(
    (s) => s.isLoadingMoreSessions,
  );
  const loadMoreSessions = useChatSessionStore((s) => s.loadMoreSessions);
  const removeSession = useChatSessionStore((s) => s.removeSession);
  const loadMoreInFlightRef = useRef(false);
  const activeSessions = useMemo(
    () =>
      getVisibleSessions(sessions, messagesBySession).filter(
        (session) => !session.archivedAt,
      ),
    [messagesBySession, sessions],
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectedCount = selectedSessionIds.size;
  const selectedSessions = useMemo(
    () =>
      activeSessions.filter((session) => selectedSessionIds.has(session.id)),
    [activeSessions, selectedSessionIds],
  );
  const clearSelection = useCallback(() => {
    setSelectedSessionIds(new Set());
  }, []);
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
  });
  const {
    error: searchError,
    isSearching,
    query: searchQuery,
    results: searchResults,
    search: submitSearch,
    searchMore,
    setQuery: setSearchQuery,
    submittedQuery,
  } = search;

  const getLoadedActiveSessions = useCallback(() => {
    const state = useChatSessionStore.getState();
    const chatState = useChatStore.getState();
    return getVisibleSessions(
      state.sessions,
      chatState.messagesBySession,
    ).filter((session) => !session.archivedAt);
  }, []);

  const loadNextPageIfNeeded = useCallback(async () => {
    const shouldSearchNewPage = Boolean(submittedQuery);
    if (
      !hasMoreSessions ||
      isLoadingMoreSessions ||
      (shouldSearchNewPage && isSearching) ||
      loadMoreInFlightRef.current
    ) {
      return;
    }

    loadMoreInFlightRef.current = true;
    try {
      await loadMoreSessions();
      if (shouldSearchNewPage) {
        await searchMore(getLoadedActiveSessions());
      }
    } finally {
      loadMoreInFlightRef.current = false;
    }
  }, [
    getLoadedActiveSessions,
    hasMoreSessions,
    isLoadingMoreSessions,
    isSearching,
    loadMoreSessions,
    searchMore,
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
  const columns = useGridColumnCount(columnProbeRef);
  const groupedRows = useMemo(
    () => flattenGroupedSessionRows(dateGroups, columns),
    [columns, dateGroups],
  );
  const groupedVirtualizer = useVirtualizer({
    count: groupedRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (groupedRows[index]?.kind === "header" ? 72 : 96),
    getItemKey: (index) => groupedRows[index]?.key ?? index,
    measureElement:
      typeof window !== "undefined" &&
      navigator.userAgent.indexOf("Firefox") === -1
        ? (element) => element?.getBoundingClientRect().height
        : undefined,
    overscan: 5,
    scrollMargin: listScrollMargin,
  });

  const isSessionNotFoundError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("not found in sessions or threads");
  }, []);
  const groupedVirtualItems = groupedVirtualizer.getVirtualItems();
  const searchRows = useMemo(
    () => flattenFlatSessionRows(searchResults, columns),
    [columns, searchResults],
  );
  const searchVirtualizer = useVirtualizer({
    count: searchRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 128,
    getItemKey: (index) => searchRows[index]?.key ?? index,
    measureElement:
      typeof window !== "undefined" &&
      navigator.userAgent.indexOf("Firefox") === -1
        ? (element) => element?.getBoundingClientRect().height
        : undefined,
    overscan: 5,
    scrollMargin: listScrollMargin,
  });
  const viewportLoadCheckState = useMemo(
    () => ({
      activeSessionCount: activeSessions.length,
      columnCount: columns,
      groupedRowCount: groupedRows.length,
      hasMoreSessions,
      searchRowCount: searchRows.length,
      sessionCount: sessions.length,
      submittedQuery,
    }),
    [
      activeSessions.length,
      columns,
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
        await onArchiveChat(sessionId);
        return;
      }

      try {
        await useChatSessionStore.getState().archiveSession(sessionId);
      } catch {
        // best-effort
      }
    },
    [onArchiveChat],
  );

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
      try {
        const session = activeSessions.find((s) => s.id === sessionId);
        const json = await acpExportSession(sessionId);
        const filename = defaultExportFilename(session?.title ?? "session");

        if (window.__TAURI_INTERNALS__) {
          const savedPath = await saveExportedSessionFile(filename, json);
          if (!savedPath) {
            return;
          }
          toast.success(`Exported session to ${filename}`);
          return;
        }

        downloadJson(json, filename);
        toast.success(`Exported session to ${filename}`);
      } catch (error) {
        console.error("Export failed:", error);
        if (isSessionNotFoundError(error)) {
          removeSession(sessionId);
        }
        toast.error("Failed to export session");
      }
    },
    [activeSessions, isSessionNotFoundError, removeSession],
  );

  const handleDuplicate = useCallback(
    async (sessionId: string) => {
      try {
        await acpDuplicateSession(sessionId);
        await loadSessions();
      } catch (error) {
        console.error("Duplicate failed:", error);
        if (isSessionNotFoundError(error)) {
          removeSession(sessionId);
        }
      }
    },
    [isSessionNotFoundError, loadSessions, removeSession],
  );

  const duplicateSelectedSessions = useCallback(async () => {
    const sessionIds = selectedSessions.map((session) => session.id);
    const result = await applySelectionAction(async (sessionId) => {
      try {
        await acpDuplicateSession(sessionId);
      } catch (error) {
        if (isSessionNotFoundError(error)) {
          removeSession(sessionId);
        }
        throw error;
      }
    }, new Set(sessionIds));
    if (result) {
      await loadSessions();
    }
  }, [
    applySelectionAction,
    isSessionNotFoundError,
    loadSessions,
    removeSession,
    selectedSessions,
  ]);

  const handleImportSession = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        await acpImportSession(text);
        await loadSessions();
      } catch (error) {
        console.error("Import failed:", error);
      } finally {
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }
    },
    [loadSessions],
  );

  const setTopBarActions = useSetTopBarActions();
  const handleTriggerImport = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  useEffect(() => {
    setTopBarActions(
      <Button
        type="button"
        variant="page-header"
        size="xs"
        onClick={handleTriggerImport}
        leftIcon={<IconUpload />}
      >
        {t("common:actions.import")}
      </Button>,
    );
    return () => setTopBarActions(null);
  }, [setTopBarActions, t, handleTriggerImport]);

  const handleSelectResult = useCallback(
    (sessionId: string, messageId?: string) => {
      if (messageId) {
        onSelectSearchResult?.(sessionId, messageId, submittedQuery);
        return;
      }
      onSelectSession?.(sessionId);
    },
    [onSelectSearchResult, onSelectSession, submittedQuery],
  );

  const renderSessionCard = useCallback(
    (
      session: ChatSession,
      options: {
        snippet?: string;
        matchCount?: number;
        messageId?: string;
      } = {},
    ) => (
      <SessionCard
        key={session.id}
        id={session.id}
        title={session.title}
        updatedAt={session.updatedAt}
        personaName={
          session.personaId ? getPersonaName(session.personaId) : undefined
        }
        projectName={
          session.projectId ? getProjectName(session.projectId) : undefined
        }
        projectColor={
          session.projectId ? getProjectColor(session.projectId) : undefined
        }
        workingDir={
          session.projectId ? getWorkingDir(session.projectId) : undefined
        }
        archivedAt={session.archivedAt}
        snippet={options.snippet}
        matchCount={options.matchCount}
        onSelect={
          options.messageId
            ? () => handleSelectResult(session.id, options.messageId)
            : onSelectSession
        }
        selected={selectedSessionIds.has(session.id)}
        selectionEnabled={selectedCount > 0}
        selectionActionsDisabled={isApplyingSelectionAction}
        selectionCount={selectedCount}
        onSelectionClear={clearSelection}
        onSelectionChange={toggleSessionSelection}
        onRename={onRenameChat}
        onArchive={handleArchive}
        onArchiveSelected={requestArchiveSelected}
        onExport={handleExport}
        onDuplicate={handleDuplicate}
        onDuplicateSelected={duplicateSelectedSessions}
      />
    ),
    [
      getPersonaName,
      getProjectColor,
      getProjectName,
      getWorkingDir,
      handleArchive,
      requestArchiveSelected,
      clearSelection,
      handleDuplicate,
      duplicateSelectedSessions,
      handleExport,
      handleSelectResult,
      isApplyingSelectionAction,
      onRenameChat,
      onSelectSession,
      selectedCount,
      selectedSessionIds,
      toggleSessionSelection,
    ],
  );

  const renderGroupedRow = useCallback(
    (row: GroupedSessionRow) => {
      if (row.kind === "header") {
        return (
          <h2
            className={cn(
              SESSION_GRID_COLS,
              "pt-10 pb-3 text-base text-foreground",
            )}
          >
            <span>{row.label}</span>
          </h2>
        );
      }

      return (
        <div className={cn(SESSION_GRID_COLS, "gap-y-4 pb-3 pt-2")}>
          {row.sessions.map((session) => renderSessionCard(session))}
        </div>
      );
    },
    [renderSessionCard],
  );

  const renderSearchRow = useCallback(
    (row: FlatSessionRow<SessionSearchDisplayResult>) => (
      <div className={cn(SESSION_GRID_COLS, "gap-y-4 pb-3")}>
        {row.items.map((result) =>
          renderSessionCard(result.session, {
            snippet: result.snippet,
            matchCount: result.matchCount,
            messageId: result.messageId,
          }),
        )}
      </div>
    ),
    [renderSessionCard],
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
      <div
        ref={setScrollNode}
        data-testid="session-history-scroll"
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-scroll [scrollbar-gutter:stable]"
      >
        <div
          ref={pageContentRef}
          className="page-transition mx-auto flex w-full max-w-none flex-col gap-5 px-6 pb-app-page-bottom pt-8"
        >
          <div className={SESSION_GRID_COLS}>
            <div className="col-span-full sm:col-span-2">
              <SearchBar
                size="pill"
                value={searchQuery}
                onChange={setSearchQuery}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitSearch();
                  }
                }}
                placeholder={t("history.searchPlaceholder")}
                aria-label={t("history.searchPlaceholder")}
              />
            </div>
          </div>

          {searchError && (
            <p className="text-xs text-destructive">
              {t("history.searchError")}
            </p>
          )}

          <div role="status" aria-live="polite" className="sr-only">
            {loadMoreStatus}
          </div>

          <div
            ref={columnProbeRef}
            aria-hidden="true"
            className={cn(
              SESSION_GRID_COLS,
              "pointer-events-none invisible h-0 gap-y-10 overflow-hidden",
            )}
          />

          {submittedQuery ? (
            searchResults.length > 0 ? (
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
            ) : (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
                <History className="h-10 w-10 opacity-30" />
                <div className="text-center">
                  <p className="text-sm font-medium">
                    {isSearching
                      ? t("history.searching")
                      : t("history.emptyNoMatches")}
                  </p>
                  {!isSearching && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("history.emptyNoMatchesHint")}
                    </p>
                  )}
                </div>
              </div>
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
                    {renderGroupedRow(row)}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
              <History className="h-10 w-10 opacity-30" />
              <div className="text-center">
                <p className="text-sm font-medium">{t("history.emptyTitle")}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("history.emptyHint")}
                </p>
              </div>
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
        loadingLabel={t("common:bulkActions.archiving")}
        isLoading={isApplyingSelectionAction}
        onConfirm={() => confirmArchiveSelected(handleArchive)}
      />
    </div>
  );
}
