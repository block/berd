import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useShallow } from "zustand/react/shallow";
import { History } from "lucide-react";
import { IconCheck, IconCopy, IconUpload, IconX } from "@tabler/icons-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { sessionActivityAt } from "@/features/chat/lib/sessionActivity";
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
import {
  saveExportedSessionFile,
  saveExportedSessionFiles,
} from "@/shared/api/system";
import { usePinBatchToHome } from "@/features/home/hooks/usePinToHomeWidget";
import {
  defaultExportFilename,
  downloadJson,
  exportFilenameFromPath,
} from "../lib/exportSession";
import {
  areSetsEqual,
  normalizeSelectedSessionIds,
  toggleSessionSelection as getToggledSessionSelection,
} from "../lib/sessionSelection";
import { useBulkSessionActions } from "../hooks/useBulkSessionActions";
import { useForkSession } from "../hooks/useForkSession";
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
  const activeSessions = useMemo(
    () =>
      getVisibleSessions(sessions, localMessageCountsBySession).filter(
        (session) => !session.archivedAt,
      ),
    [localMessageCountsBySession, sessions],
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
    const message = formatAcpErrorMessage(error, "");
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

      void useChatSessionStore
        .getState()
        .archiveSession(sessionId)
        .catch((err: unknown) =>
          console.error("Failed to archive session in backend:", err),
        );
    },
    [onArchiveChat],
  );

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
      try {
        const session = activeSessions.find((s) => s.id === sessionId);
        const json = await acpExportSession(sessionId);
        const filename = defaultExportFilename(session?.title ?? "session");
        const sessionName = session
          ? getDisplayTitle(session)
          : defaultSessionTitle;

        if (window.__TAURI_INTERNALS__) {
          const savedPath = await saveExportedSessionFile(filename, json);
          if (!savedPath) {
            return;
          }
          const savedFilename = exportFilenameFromPath(savedPath, filename);
          toast.success(`Exported ${sessionName} to ${savedFilename}`);
          return;
        }

        downloadJson(json, filename);
        toast.success(`Exported ${sessionName} to ${filename}`);
      } catch (error) {
        console.error("Export failed:", error);
        if (isSessionNotFoundError(error)) {
          removeSession(sessionId);
        }
        toast.error(formatAcpErrorMessage(error, "Failed to export session"));
      }
    },
    [
      activeSessions,
      defaultSessionTitle,
      getDisplayTitle,
      isSessionNotFoundError,
      removeSession,
    ],
  );

  const handleOpenInWindow = useCallback(
    (sessionId: string) => {
      const isOpenInWindow =
        sessionId in useSessionWindowStore.getState().openSessions;
      const runtime = useChatStore.getState().sessionStateById[sessionId];
      const isRunning = Boolean(
        runtime && (runtime.chatState !== "idle" || runtime.streamingMessageId),
      );
      const action = isOpenInWindow
        ? () => focusSessionWindow(sessionId)
        : () => openSessionWindow(sessionId, { handoff: isRunning });

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

  const { pinBatchToHome, isPinningBatch } = usePinBatchToHome();
  const handlePinSelectedToHome = useCallback(async () => {
    const ids = Array.from(selectedSessionIds);
    if (ids.length === 0) return;
    await pinBatchToHome("chat", ids);
    clearSelection();
  }, [clearSelection, pinBatchToHome, selectedSessionIds]);

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
        preserveWidth
      >
        {t("common:actions.import")}
      </PageHeaderButton>,
    );
    return () => setTopBarActions(null);
  }, [setTopBarActions, t, handleTriggerImport, isImporting]);

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
      options?: {
        snippet?: string;
        matchCount?: number;
        messageId?: string;
      },
    ) => {
      const isSearchResult = options !== undefined;
      const messageId = options?.messageId;
      const snippet = options
        ? options.snippet
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
          snippet={snippet}
          snippetLineClamp={isSearchResult ? undefined : 1}
          matchCount={options?.matchCount}
          onSelect={
            messageId
              ? () => handleSelectResult(session.id, messageId)
              : onSelectSession
          }
          selected={selectedSessionIds.has(session.id)}
          selectionEnabled={selectedCount > 0}
          selectionActionsDisabled={isApplyingSelectionAction}
          selectionCount={selectedCount}
          onSelectionClear={clearSelection}
          onSelectionChange={toggleSessionSelection}
          onRename={onRenameChat}
          onFork={handleFork}
          onArchive={handleArchive}
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
          isPinningSelectedToHome={isPinningBatch}
        />
      );
    },
    [
      getPersonaName,
      getProjectColor,
      getProjectName,
      getWorkingDir,
      handleArchive,
      handleFork,
      requestArchiveSelected,
      clearSelection,
      handleExport,
      handleExportSelected,
      handleOpenInWindow,
      handlePinSelectedToHome,
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
    ],
  );

  const renderGroupedRow = useCallback(
    (row: GroupedSessionRow, isFirstRow = false) => {
      if (row.kind === "header") {
        return (
          <h2
            className={cn(
              SESSION_GRID_COLS,
              "pb-3 text-base text-foreground",
              // The page container already spaces the search bar from the
              // first group; only stack extra top padding between groups.
              isFirstRow ? "pt-1" : "pt-10",
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
                            title={t("history.copyImportCommand")}
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
                      title={t("common:actions.close")}
                      onClick={handleDismissImportNotice}
                    >
                      <IconX />
                    </Button>
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}

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
                    {renderGroupedRow(row, virtualRow.index === 0)}
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
        destructive={false}
        loadingLabel={t("common:bulkActions.archiving")}
        isLoading={isApplyingSelectionAction}
        onConfirm={() => confirmArchiveSelected(handleArchive)}
      />
    </div>
  );
}
