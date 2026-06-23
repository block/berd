import {
  type CSSProperties,
  type KeyboardEventHandler,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { AppView } from "@/app/AppShell";
import {
  selectDraftsBySession,
  selectMessagesBySession,
  selectSessionStateById,
} from "@/features/chat/stores/chatSelectors";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { selectSessions } from "@/features/chat/stores/chatSessionSelectors";
import {
  type ChatSession,
  getVisibleSessions,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import { usePinBatchToHome } from "@/features/home/hooks/usePinToHomeWidget";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useBulkSessionActions } from "@/features/sessions/hooks/useBulkSessionActions";
import {
  areSetsEqual,
  normalizeSelectedSessionIds,
  toggleSessionSelection as getToggledSessionSelection,
} from "@/features/sessions/lib/sessionSelection";
import { useSidebarBranchSubtitles } from "@/features/sidebar/hooks/useSidebarBranchSubtitles";
import { useSidebarGitBranchSubtitlePreference } from "@/features/sidebar/lib/sidebarBranchSubtitlePreference";
import {
  DEFAULT_SIDEBAR_FLAT_CHAT_LIST_GROUP_CHATS_BY_PROJECT,
  SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID,
  SIDEBAR_FLAT_CHAT_LIST_GROUP_CHATS_BY_PROJECT_CONFIG_KEY,
} from "@/features/experiments/experimentDefinitions";
import { useExperiment } from "@/features/experiments/experimentPreferences";
import {
  MAX_FLAT_SIDEBAR_CHATS,
  groupFlatChatsByActivityAge,
  limitFlatSidebarSessions,
} from "@/features/sidebar/lib/sidebarFlatChats";
import type { SessionChatRuntime } from "@/shared/types/chat";
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";
import { usePersistedState } from "@/shared/hooks/usePersistedState";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import type { SidebarSessionItem } from "@/features/sessions/ui/session-list/SidebarProjectSection";
import type { SidebarProjectsSectionProps } from "@/features/sessions/ui/session-list/SidebarProjectsSection";
import { SessionListSurface } from "./SessionListSurface";

const EXPANDED_PROJECTS_STORAGE_KEY = "goose:sidebar:expanded-projects";
const SECTION_VISIBILITY_STORAGE_KEY = "goose:sidebar:section-visibility";
const MAX_RECENTS = 20;
const FLAT_CHAT_GROUP_REFRESH_INTERVAL_MS = 60 * 1000;

type SessionListSectionVisibility = {
  projects: boolean;
  recents: boolean;
};

const DEFAULT_SECTION_VISIBILITY: SessionListSectionVisibility = {
  projects: true,
  recents: true,
};

type SessionListGroups = {
  byProject: Record<string, SidebarSessionItem[]>;
  standalone: SidebarSessionItem[];
};

const EMPTY_SESSION_LIST_GROUPS: SessionListGroups = {
  byProject: {},
  standalone: [],
};

type SessionListSurfaceOptions = {
  ariaLabel?: string;
  bottomMaskStyle?: CSSProperties;
  dragging?: boolean;
  elevatedHoverShadow?: boolean;
  navRef?: Ref<HTMLElement>;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  preview?: boolean;
  renderDragHandle: () => ReactNode;
  renderResizeRail?: () => ReactNode;
  showBottomMask?: boolean;
  showTopDivider: boolean;
  sideDocked?: boolean;
  variant: "embedded" | "panel";
};

export interface SessionListCapabilityProps {
  activeSessionId?: string | null;
  collapsed: boolean;
  labelTransition: string;
  labelVisible: boolean;
  onArchiveChat?: (sessionId: string) => void | Promise<void>;
  onArchiveProject?: (projectId: string) => void;
  onCreateProject?: () => void;
  onEditProject?: (projectId: string) => void;
  onMarkChatRead?: (sessionId: string) => void;
  onMarkChatUnread?: (sessionId: string) => void;
  onMoveToProject?: (sessionId: string, projectId: string | null) => void;
  onNavigate?: (view: AppView) => void;
  onNewChat?: () => void;
  onNewChatInProject?: (projectId: string) => void;
  onRenameChat?: (sessionId: string, nextTitle: string) => void;
  onReorderProject?: (fromId: string, toId: string) => void;
  onSelectSession?: (sessionId: string) => void;
  onSessionSelectForScroll?: (sessionId: string) => void;
  projects: ProjectInfo[];
  surface: SessionListSurfaceOptions;
}

function validateExpandedProjects(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const entries = Object.entries(value).filter(
    (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
  );
  return Object.fromEntries(entries);
}

function compareSessionsByUpdatedAtDesc(
  a: Pick<SidebarSessionItem, "updatedAt">,
  b: Pick<SidebarSessionItem, "updatedAt">,
): number {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function toSessionListItem(
  session: ChatSession,
  sessionStateById: Record<string, SessionChatRuntime>,
  branchNameBySessionId: ReadonlyMap<string, string>,
): SidebarSessionItem {
  const runtime = sessionStateById[session.id] ?? INITIAL_SESSION_CHAT_RUNTIME;
  const branchName = branchNameBySessionId.get(session.id);
  return {
    id: session.id,
    title: session.title,
    subtitle: branchName ?? session.subtitle ?? undefined,
    projectId: session.projectId ?? undefined,
    updatedAt: session.updatedAt,
    isRunning: isSessionRunning(runtime.chatState),
    hasUnread: runtime.hasUnread,
  };
}

function getFlatSessionListItems(
  visibleSessions: ChatSession[],
  projectsById: ReadonlyMap<string, ProjectInfo>,
  sessionStateById: Record<string, SessionChatRuntime>,
  placeholderSessionIds: ReadonlySet<string>,
  branchNameBySessionId: ReadonlyMap<string, string>,
): SidebarSessionItem[] {
  const sessions = visibleSessions
    .filter((session) => !session.archivedAt)
    .map((session) => {
      const project = session.projectId
        ? projectsById.get(session.projectId)
        : undefined;
      const item = toSessionListItem(
        session,
        sessionStateById,
        branchNameBySessionId,
      );
      return {
        ...item,
        projectName: project?.name,
        projectIcon: project?.icon,
        projectColor: project?.color,
      };
    })
    .sort((a, b) => compareSessionListItems(a, b, placeholderSessionIds));

  return sessions;
}

function getSessionListGroups(
  visibleSessions: ChatSession[],
  projectIds: ReadonlySet<string>,
  sessionStateById: Record<string, SessionChatRuntime>,
  placeholderSessionIds: ReadonlySet<string>,
  branchNameBySessionId: ReadonlyMap<string, string>,
): SessionListGroups {
  const byProject: Record<string, SidebarSessionItem[]> = {};
  const standalone: SidebarSessionItem[] = [];

  for (const session of visibleSessions) {
    if (session.archivedAt) continue;
    const item = toSessionListItem(
      session,
      sessionStateById,
      branchNameBySessionId,
    );
    if (session.projectId && projectIds.has(session.projectId)) {
      byProject[session.projectId] ??= [];
      byProject[session.projectId].push(item);
    } else {
      standalone.push(item);
    }
  }

  for (const chats of Object.values(byProject)) {
    chats.sort((a, b) => compareSessionListItems(a, b, placeholderSessionIds));
  }

  const sortedStandalone = standalone.sort((a, b) =>
    compareSessionListItems(a, b, placeholderSessionIds),
  );
  const standalonePlaceholders = sortedStandalone.filter((session) =>
    placeholderSessionIds.has(session.id),
  );
  const standaloneRecents = sortedStandalone
    .filter((session) => !placeholderSessionIds.has(session.id))
    .slice(0, MAX_RECENTS);

  return {
    byProject,
    standalone: [...standalonePlaceholders, ...standaloneRecents],
  };
}

function compareSessionListItems(
  a: SidebarSessionItem,
  b: SidebarSessionItem,
  placeholderSessionIds: ReadonlySet<string>,
): number {
  const aIsPlaceholder = placeholderSessionIds.has(a.id);
  const bIsPlaceholder = placeholderSessionIds.has(b.id);
  if (aIsPlaceholder !== bIsPlaceholder) {
    return aIsPlaceholder ? -1 : 1;
  }

  return compareSessionsByUpdatedAtDesc(a, b);
}

function includeSessionListPlaceholderSessions(
  visibleSessions: ChatSession[],
  sessions: ChatSession[],
  draftsBySession: Record<string, string>,
  activeSessionId?: string | null,
): {
  sessions: ChatSession[];
  placeholderSessionIds: ReadonlySet<string>;
} {
  const visibleSessionIds = new Set(
    visibleSessions.map((session) => session.id),
  );
  const additionalSessions = sessions.filter((session) => {
    if (visibleSessionIds.has(session.id) || session.archivedAt) {
      return false;
    }

    return (
      session.id === activeSessionId ||
      (draftsBySession[session.id] ?? "").length > 0
    );
  });
  const placeholderSessionIds = new Set(
    additionalSessions.map((session) => session.id),
  );

  if (additionalSessions.length === 0) {
    return { sessions: visibleSessions, placeholderSessionIds };
  }

  return {
    sessions: [...additionalSessions, ...visibleSessions],
    placeholderSessionIds,
  };
}

function validateSectionVisibility(
  value: unknown,
  defaults: SessionListSectionVisibility,
): SessionListSectionVisibility {
  if (!value || typeof value !== "object") return defaults;
  const parsed = value as Partial<
    Record<keyof SessionListSectionVisibility, unknown>
  >;
  return {
    projects:
      typeof parsed.projects === "boolean"
        ? parsed.projects
        : defaults.projects,
    recents:
      typeof parsed.recents === "boolean" ? parsed.recents : defaults.recents,
  };
}

export function SessionListCapability({
  activeSessionId,
  collapsed,
  labelTransition,
  labelVisible,
  onArchiveChat,
  onArchiveProject,
  onCreateProject,
  onEditProject,
  onMarkChatRead,
  onMarkChatUnread,
  onMoveToProject,
  onNavigate,
  onNewChat,
  onNewChatInProject,
  onRenameChat,
  onReorderProject,
  onSelectSession,
  onSessionSelectForScroll,
  projects,
  surface,
}: SessionListCapabilityProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const [expandedProjects, setExpandedProjects] = useState<
    Record<string, boolean>
  >(() => {
    if (typeof window === "undefined") return {};
    try {
      const stored = window.localStorage.getItem(EXPANDED_PROJECTS_STORAGE_KEY);
      if (!stored) return {};
      const parsed = JSON.parse(stored);
      return validateExpandedProjects(parsed);
    } catch {
      return {};
    }
  });
  const [sectionVisibility, setSectionVisibility] = usePersistedState(
    SECTION_VISIBILITY_STORAGE_KEY,
    DEFAULT_SECTION_VISIBILITY,
    validateSectionVisibility,
  );
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const messagesBySession = useChatStore(selectMessagesBySession);
  const draftsBySession = useChatStore(selectDraftsBySession);
  const sessionStateById = useChatStore(selectSessionStateById);
  const sessions = useChatSessionStore(selectSessions);
  const activeWorkspaceBySession = useChatSessionStore(
    (s) => s.activeWorkspaceBySession,
  );
  const hasMoreSessions = useChatSessionStore((s) => s.hasMoreSessions);
  const isLoadingMoreSessions = useChatSessionStore(
    (s) => s.isLoadingMoreSessions,
  );
  const sessionPageCursor = useChatSessionStore((s) => s.sessionPageCursor);
  const loadMoreSessions = useChatSessionStore((s) => s.loadMoreSessions);
  const gitBranchSubtitlePreference = useSidebarGitBranchSubtitlePreference();
  const sidebarFlatChatListExperiment = useExperiment(
    SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID,
  );
  const groupChatsByProject =
    !sidebarFlatChatListExperiment?.enabled ||
    Boolean(
      sidebarFlatChatListExperiment.config[
        SIDEBAR_FLAT_CHAT_LIST_GROUP_CHATS_BY_PROJECT_CONFIG_KEY
      ] ?? DEFAULT_SIDEBAR_FLAT_CHAT_LIST_GROUP_CHATS_BY_PROJECT,
    );
  const [flatChatGroupNowMs, setFlatChatGroupNowMs] = useState(() =>
    Date.now(),
  );
  const attemptedFlatChatLoadMoreCursorRef = useRef<string | null>(null);
  const projectIds = useMemo(
    () => new Set(projects.map((project) => project.id)),
    [projects],
  );
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const visibleSessions = useMemo(
    () =>
      includeSessionListPlaceholderSessions(
        getVisibleSessions(sessions, messagesBySession),
        sessions,
        draftsBySession,
        activeSessionId,
      ),
    [activeSessionId, draftsBySession, messagesBySession, sessions],
  );
  const activeSessions = useMemo(
    () => visibleSessions.sessions.filter((session) => !session.archivedAt),
    [visibleSessions],
  );
  const activeSessionIds = useMemo(
    () => new Set(activeSessions.map((session) => session.id)),
    [activeSessions],
  );
  const branchNameBySessionId = useSidebarBranchSubtitles({
    sessions: visibleSessions.sessions,
    activeWorkspaceBySession,
    enabled: gitBranchSubtitlePreference.enabled && groupChatsByProject,
  });
  const selectedCount = selectedSessionIds.size;
  const clearSelection = () => setSelectedSessionIds(new Set());

  useEffect(() => {
    if (selectedCount === 0) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (target.closest("[data-sidebar-chat-row]")) return;
      if (
        target.closest('[role="menu"]') ||
        target.closest('[role="dialog"]') ||
        target.closest('[role="alertdialog"]')
      ) {
        return;
      }
      setSelectedSessionIds(new Set());
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [selectedCount]);

  const reportBulkFailure = (failedCount: number) => {
    toast.error(
      t("common:bulkActions.failed", {
        count: failedCount,
        displayCount: failedCount,
      }),
    );
  };
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

  const { pinBatchToHome, isPinningBatch } = usePinBatchToHome();
  const handlePinSelectedToHome = useCallback(async () => {
    await pinBatchToHome("chat", Array.from(selectedSessionIds));
    setSelectedSessionIds(new Set());
  }, [pinBatchToHome, selectedSessionIds]);

  const selectSession = useCallback(
    (sessionId: string) => {
      onSessionSelectForScroll?.(sessionId);
      onSelectSession?.(sessionId);
    },
    [onSelectSession, onSessionSelectForScroll],
  );

  useEffect(() => {
    setSelectedSessionIds((current) => {
      const next = normalizeSelectedSessionIds({
        current,
        activeSessionIds,
        activeSessionId,
        includeActiveSession: true,
      });

      return areSetsEqual(next, current) ? current : next;
    });
  }, [activeSessionId, activeSessionIds]);

  useEffect(() => {
    if (groupChatsByProject) return;
    setFlatChatGroupNowMs(Date.now());
    const interval = window.setInterval(() => {
      setFlatChatGroupNowMs(Date.now());
    }, FLAT_CHAT_GROUP_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [groupChatsByProject]);

  useEffect(() => {
    if (groupChatsByProject) {
      attemptedFlatChatLoadMoreCursorRef.current = null;
    }
  }, [groupChatsByProject]);

  const projectSessions = useMemo(
    () =>
      groupChatsByProject
        ? getSessionListGroups(
            visibleSessions.sessions,
            projectIds,
            sessionStateById,
            visibleSessions.placeholderSessionIds,
            branchNameBySessionId,
          )
        : EMPTY_SESSION_LIST_GROUPS,
    [
      branchNameBySessionId,
      groupChatsByProject,
      projectIds,
      sessionStateById,
      visibleSessions,
    ],
  );
  const flatSessionCandidates = useMemo(() => {
    if (groupChatsByProject) return [];
    return getFlatSessionListItems(
      visibleSessions.sessions,
      projectsById,
      sessionStateById,
      visibleSessions.placeholderSessionIds,
      branchNameBySessionId,
    );
  }, [
    branchNameBySessionId,
    groupChatsByProject,
    projectsById,
    sessionStateById,
    visibleSessions,
  ]);
  const flatSessions = useMemo(
    () => limitFlatSidebarSessions(flatSessionCandidates),
    [flatSessionCandidates],
  );
  const flatChatGroups = useMemo(
    () =>
      groupChatsByProject
        ? []
        : groupFlatChatsByActivityAge(flatSessions, flatChatGroupNowMs),
    [flatChatGroupNowMs, flatSessions, groupChatsByProject],
  );
  const hasFlatChatOverflow =
    flatSessionCandidates.length > MAX_FLAT_SIDEBAR_CHATS ||
    (flatSessionCandidates.length >= MAX_FLAT_SIDEBAR_CHATS && hasMoreSessions);
  const flatChatLoadMoreCursorKey = sessionPageCursor ?? "__initial__";

  useEffect(() => {
    if (
      surface.preview ||
      groupChatsByProject ||
      !hasMoreSessions ||
      isLoadingMoreSessions ||
      flatSessionCandidates.length >= MAX_FLAT_SIDEBAR_CHATS
    ) {
      return;
    }
    if (
      attemptedFlatChatLoadMoreCursorRef.current === flatChatLoadMoreCursorKey
    ) {
      return;
    }

    attemptedFlatChatLoadMoreCursorRef.current = flatChatLoadMoreCursorKey;
    void loadMoreSessions();
  }, [
    flatChatLoadMoreCursorKey,
    flatSessionCandidates.length,
    groupChatsByProject,
    hasMoreSessions,
    isLoadingMoreSessions,
    loadMoreSessions,
    surface.preview,
  ]);

  const activeProjectId = useMemo(() => {
    if (!activeSessionId) return undefined;
    return sessions.find((session) => session.id === activeSessionId)
      ?.projectId;
  }, [activeSessionId, sessions]);

  useEffect(() => {
    if (!activeProjectId || !projectIds.has(activeProjectId)) return;
    setExpandedProjects((prev) => {
      if (prev[activeProjectId]) return prev;
      return { ...prev, [activeProjectId]: true };
    });
  }, [activeProjectId, projectIds]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        EXPANDED_PROJECTS_STORAGE_KEY,
        JSON.stringify(expandedProjects),
      );
    } catch {
      // localStorage may be unavailable
    }
  }, [expandedProjects]);

  useEffect(() => {
    setExpandedProjects((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([projectId]) => projectIds.has(projectId)),
      );
      return Object.keys(next).length === Object.keys(prev).length
        ? prev
        : next;
    });
  }, [projectIds]);

  const toggleProject = useCallback((projectId: string) => {
    setExpandedProjects((prev) => ({
      ...prev,
      [projectId]: !prev[projectId],
    }));
  }, []);
  const toggleSection = (section: keyof SessionListSectionVisibility) => {
    setSectionVisibility((prev) => ({ ...prev, [section]: !prev[section] }));
  };
  const toggleSessionSelection = (sessionId: string, selected: boolean) => {
    setSelectedSessionIds((current) =>
      getToggledSessionSelection({
        current,
        sessionId,
        selected,
        activeSessionId,
        activeSessionIds,
        includeActiveSessionOnStart: true,
        clearActiveOnlySelection: true,
      }),
    );
  };

  const sectionProps: SidebarProjectsSectionProps = {
    projects,
    projectSessions,
    hasVisibleChats: activeSessions.length > 0,
    flatChatGroups,
    hasFlatChatOverflow,
    groupChatsByProject,
    expandedProjects,
    toggleProject,
    collapsed,
    labelTransition,
    labelVisible,
    activeSessionId,
    onNavigate,
    onSelectSession: selectSession,
    onNewChatInProject,
    onNewChat,
    onCreateProject,
    onEditProject,
    onArchiveProject,
    onArchiveChat,
    onRenameChat,
    onMarkChatRead,
    onMarkChatUnread,
    onMoveToProject,
    selectedSessionIds,
    selectionEnabled: selectedCount > 0,
    selectionActionsDisabled: isApplyingSelectionAction,
    onSelectionClear: clearSelection,
    onSelectionChange: toggleSessionSelection,
    onArchiveSelected: requestArchiveSelected,
    onPinSelectedToHome: handlePinSelectedToHome,
    isPinningSelectedToHome: isPinningBatch,
    onMarkSelectedRead: () => void applySelectionAction(onMarkChatRead),
    onMarkSelectedUnread: () => void applySelectionAction(onMarkChatUnread),
    onReorderProject,
    hasMoreSessions,
    projectsSectionOpen: sectionVisibility.projects,
    recentsSectionOpen: sectionVisibility.recents,
    onToggleProjectsSection: () => toggleSection("projects"),
    onToggleRecentsSection: () => toggleSection("recents"),
    showTopDivider: surface.showTopDivider,
  };

  return (
    <>
      <SessionListSurface {...surface} sectionProps={sectionProps} />
      {!surface.preview && (
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
          confirmVariant="default"
          loadingLabel={t("common:bulkActions.archiving")}
          isLoading={isApplyingSelectionAction}
          onConfirm={() => confirmArchiveSelected(onArchiveChat)}
        />
      )}
    </>
  );
}
