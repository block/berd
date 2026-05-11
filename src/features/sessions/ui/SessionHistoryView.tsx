import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  defaultRangeExtractor,
  type Range,
  useVirtualizer,
} from "@tanstack/react-virtual";
import { History, Upload } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { getDisplaySessionTitle } from "@/features/chat/lib/sessionTitle";
import { SearchBar } from "@/shared/ui/SearchBar";
import { Button } from "@/shared/ui/button";
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
import { useSessionSearch } from "../hooks/useSessionSearch";
import {
  flattenFlatSessionRows,
  flattenGroupedSessionRows,
  type FlatSessionRow,
  type GroupedSessionRow,
} from "../lib/flattenSessionRows";
import { useGridColumnCount } from "../hooks/useGridColumnCount";
import type { SessionSearchDisplayResult } from "../lib/buildSessionSearchResults";

interface SessionHistoryViewProps {
  onSelectSession?: (sessionId: string) => void;
  onSelectSearchResult?: (
    sessionId: string,
    messageId?: string,
    query?: string,
  ) => void;
  onRenameChat?: (sessionId: string, nextTitle: string) => void;
  onArchiveChat?: (sessionId: string) => void;
}

export function SessionHistoryView({
  onSelectSession,
  onSelectSearchResult,
  onRenameChat,
  onArchiveChat,
}: SessionHistoryViewProps) {
  const { t, i18n } = useTranslation(["sessions", "common"]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageContentRef = useRef<HTMLDivElement>(null);
  const columnProbeRef = useRef<HTMLDivElement>(null);
  const virtualListRef = useRef<HTMLDivElement>(null);
  const [virtualListElement, setVirtualListElementState] =
    useState<HTMLDivElement | null>(null);
  const [listScrollMargin, setListScrollMargin] = useState(0);
  const sessions = useChatSessionStore(selectSessions);
  const messagesBySession = useChatStore(selectMessagesBySession);
  const loadSessions = useChatSessionStore((s) => s.loadSessions);
  const activeSessions = useMemo(
    () =>
      getVisibleSessions(sessions, messagesBySession).filter(
        (session) => !session.archivedAt,
      ),
    [messagesBySession, sessions],
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  const getPersonaName = useCallback(
    (personaId: string) =>
      useAgentStore.getState().getPersonaById(personaId)?.displayName,
    [],
  );

  const projects = useProjectStore(selectProjects);
  const getProjectName = useCallback(
    (projectId: string) => projects.find((p) => p.id === projectId)?.name,
    [projects],
  );

  const getProjectColor = useCallback(
    (projectId: string) => projects.find((p) => p.id === projectId)?.color,
    [projects],
  );

  const getWorkingDir = useCallback(
    (projectId: string) =>
      projects.find((p) => p.id === projectId)?.workingDirs[0],
    [projects],
  );

  const resolvers = { getPersonaName, getProjectName };
  const search = useSessionSearch({
    sessions: activeSessions,
    resolvers,
    locale: i18n.resolvedLanguage,
    getDisplayTitle: (session) =>
      getDisplaySessionTitle(session.title, t("common:session.defaultTitle")),
  });
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
  }, [getVirtualListScrollMargin]);
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
  const groupedHeaderIndexes = useMemo(
    () =>
      groupedRows.flatMap((row, index) =>
        row.kind === "header" ? [index] : [],
      ),
    [groupedRows],
  );
  const groupedRangeExtractor = useCallback(
    (range: Range) => {
      const activeHeaderIndex =
        groupedHeaderIndexes.findLast((index) => index <= range.startIndex) ??
        null;

      const baseRange = defaultRangeExtractor(range);
      if (activeHeaderIndex == null || baseRange.includes(activeHeaderIndex)) {
        return baseRange;
      }

      return [activeHeaderIndex, ...baseRange];
    },
    [groupedHeaderIndexes],
  );
  const groupedVirtualizer = useVirtualizer({
    count: groupedRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (groupedRows[index]?.kind === "header" ? 32 : 96),
    getItemKey: (index) => groupedRows[index]?.key ?? index,
    measureElement:
      typeof window !== "undefined" &&
      navigator.userAgent.indexOf("Firefox") === -1
        ? (element) => element?.getBoundingClientRect().height
        : undefined,
    overscan: 5,
    rangeExtractor: groupedRangeExtractor,
    scrollMargin: listScrollMargin,
  });
  const groupedVirtualItems = groupedVirtualizer.getVirtualItems();
  const firstGroupedVirtualIndex = groupedVirtualItems[0]?.index ?? 0;
  const activeGroupedHeaderIndex = useMemo(
    () =>
      groupedHeaderIndexes.findLast(
        (index) => index <= firstGroupedVirtualIndex,
      ) ?? null,
    [firstGroupedVirtualIndex, groupedHeaderIndexes],
  );
  const searchRows = useMemo(
    () => flattenFlatSessionRows(search.results, columns),
    [columns, search.results],
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
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("not found in sessions or threads")) {
          await loadSessions();
        }
        toast.error("Failed to export session");
      }
    },
    [activeSessions, loadSessions],
  );

  const handleDuplicate = useCallback(
    async (sessionId: string) => {
      try {
        await acpDuplicateSession(sessionId);
        await loadSessions();
      } catch (error) {
        console.error("Duplicate failed:", error);
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("not found in sessions or threads")) {
          await loadSessions();
        }
      }
    },
    [loadSessions],
  );

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

  const handleSelectResult = useCallback(
    (sessionId: string, messageId?: string) => {
      if (messageId) {
        onSelectSearchResult?.(sessionId, messageId, search.submittedQuery);
        return;
      }
      onSelectSession?.(sessionId);
    },
    [onSelectSearchResult, onSelectSession, search.submittedQuery],
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
        onRename={onRenameChat}
        onArchive={handleArchive}
        onExport={handleExport}
        onDuplicate={handleDuplicate}
      />
    ),
    [
      getPersonaName,
      getProjectColor,
      getProjectName,
      getWorkingDir,
      handleArchive,
      handleDuplicate,
      handleExport,
      handleSelectResult,
      onRenameChat,
      onSelectSession,
    ],
  );

  const renderGroupedRow = useCallback(
    (row: GroupedSessionRow) => {
      if (row.kind === "header") {
        return (
          <h2 className="bg-background py-1 text-sm font-medium text-muted-foreground">
            {row.label}
          </h2>
        );
      }

      return (
        <div className="grid grid-cols-1 gap-3 pb-3 pt-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {row.sessions.map((session) => renderSessionCard(session))}
        </div>
      );
    },
    [renderSessionCard],
  );

  const renderSearchRow = useCallback(
    (row: FlatSessionRow<SessionSearchDisplayResult>) => (
      <div className="grid grid-cols-1 gap-3 pb-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div
          ref={pageContentRef}
          className="page-transition mx-auto flex w-full max-w-5xl flex-col gap-5 px-6 py-8"
        >
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="font-display text-lg font-semibold tracking-tight">
                {t("history.title")}
              </h1>
              <p className="text-xs text-muted-foreground">
                {t("history.subtitle")}
              </p>
            </div>
            <Button
              type="button"
              variant="outline-flat"
              size="xs"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="size-3.5" />
              {t("common:actions.import")}
            </Button>
          </div>

          <SearchBar
            value={search.query}
            onChange={search.setQuery}
            placeholder={t("history.searchPlaceholder")}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void search.search();
              }
            }}
          />

          {search.error && (
            <p className="text-xs text-danger">{t("history.searchError")}</p>
          )}

          <div
            ref={columnProbeRef}
            aria-hidden="true"
            className="pointer-events-none invisible grid h-0 grid-cols-1 gap-3 overflow-hidden sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
          />

          {search.submittedQuery ? (
            search.results.length > 0 ? (
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
                    {search.isSearching
                      ? t("history.searching")
                      : t("history.emptyNoMatches")}
                  </p>
                  {!search.isSearching && (
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

                const isActiveHeader =
                  row.kind === "header" &&
                  virtualRow.index === activeGroupedHeaderIndex;

                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={groupedVirtualizer.measureElement}
                    className="left-0 top-0 w-full"
                    style={
                      isActiveHeader
                        ? {
                            position: "sticky",
                            top: 0,
                            zIndex: 20,
                          }
                        : {
                            position: "absolute",
                            transform: `translateY(${
                              virtualRow.start - listScrollMargin
                            }px)`,
                          }
                    }
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
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleImportSession}
        className="hidden"
      />
    </div>
  );
}
