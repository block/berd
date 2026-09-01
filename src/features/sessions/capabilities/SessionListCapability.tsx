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
  useSyncExternalStore,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { AppView } from "@/app/AppShell";
import {
  selectLocalMessageCountsBySession,
  selectNonEmptyDraftSessionIds,
  selectSessionStateById,
} from "@/features/chat/stores/chatSelectors";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { selectSessions } from "@/features/chat/stores/chatSessionSelectors";
import {
  type ChatSession,
  getVisibleSessions,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import type { SessionAction } from "@/features/sessions/lib/sessionSelection";
import {
  compareSessionsByActivityDesc,
  isSessionRunning,
  sessionActivityAt,
  sessionNeedsWindowHandoff,
} from "@/features/chat/lib/sessionActivity";
import {
  focusSessionWindow,
  openSessionWindow,
} from "@/features/chat/lib/sessionWindowCommands";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { getPinnedHomeChatSessionIdsInOrder } from "@/features/home/lib/pinnedHomeChats";
import { usePinBatchToHome } from "@/features/home/hooks/usePinToHomeWidget";
import { useHomeWidgetStore } from "@/features/home/stores/homeWidgetStore";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { useBulkSessionActions } from "@/features/sessions/hooks/useBulkSessionActions";
import {
  areSetsEqual,
  getRenderedSessionIdsInOrder,
  getSessionRangeSelection,
  normalizeSelectedSessionIds,
  toggleSessionSelection as getToggledSessionSelection,
} from "@/features/sessions/lib/sessionSelection";
import { useSidebarBranchSubtitles } from "@/features/sidebar/hooks/useSidebarBranchSubtitles";
import { useSidebarChatGroupingPreference } from "@/features/sidebar/lib/sidebarChatGroupingPreference";
import {
  MAX_FLAT_SIDEBAR_CHATS,
  groupFlatChatsByActivityAge,
  limitFlatSidebarSessions,
} from "@/features/sidebar/lib/sidebarFlatChats";
import type { SessionChatRuntime } from "@/shared/types/chat";
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";
import { usePersistedState } from "@/shared/hooks/usePersistedState";
import {
  getChatSessionIdsWithTerminals,
  subscribeTerminalSessionRegistry,
} from "@/features/terminal/lib/terminalSessionManager";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import type { SidebarSessionItem } from "@/features/sessions/ui/session-list/SidebarProjectSection";
import type {
  SidebarPinnedNavigationItem,
  SidebarProjectsSectionProps,
} from "@/features/sessions/ui/session-list/SidebarProjectsSection";
import { SessionListSurface } from "./SessionListSurface";

const EXPANDED_PROJECTS_STORAGE_KEY = "goose:sidebar:expanded-projects";
const SECTION_VISIBILITY_STORAGE_KEY = "goose:sidebar:section-visibility";
const DISPLAY_OPTIONS_STORAGE_KEY = "goose:sidebar:display-options";
const PINNED_NAV_ORDER_STORAGE_KEY = "goose:sidebar:pinned-nav-order";
const MAX_RECENTS = MAX_FLAT_SIDEBAR_CHATS;
const MAX_AUTO_LOADED_GROUPED_CHATS = MAX_FLAT_SIDEBAR_CHATS * 2;
const FLAT_CHAT_GROUP_REFRESH_INTERVAL_MS = 60 * 1000;

type SessionListSectionVisibility = {
  pinned: boolean;
  projects: boolean;
  recents: boolean;
};

type SessionListDisplayOptions = {
  pinnedShowChatIcons: boolean;
  pinnedShowTimestamps: boolean;
  projectShowChatIcons: boolean;
  projectShowTimestamps: boolean;
  chatShowChatIcons: boolean;
  chatShowTimestamps: boolean;
};

const DEFAULT_SECTION_VISIBILITY: SessionListSectionVisibility = {
  pinned: true,
  projects: true,
  recents: true,
};

const DEFAULT_DISPLAY_OPTIONS: SessionListDisplayOptions = {
  pinnedShowChatIcons: true,
  pinnedShowTimestamps: true,
  projectShowChatIcons: false,
  projectShowTimestamps: true,
  chatShowChatIcons: false,
  chatShowTimestamps: true,
};

type SessionListGroups = {
  byProject: Record<string, SidebarSessionItem[]>;
  standalone: SidebarSessionItem[];
  /** True when loaded standalone chats were truncated to MAX_RECENTS. */
  standaloneOverflow: boolean;
};

const EMPTY_SESSION_LIST_GROUPS: SessionListGroups = {
  byProject: {},
  standalone: [],
  standaloneOverflow: false,
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
  onArchiveChat?: SessionAction;
  onArchiveProject?: (projectId: string) => void;
  onCreateProject?: () => void;
  onEditProject?: (projectId: string) => void;
  onForkChat?: (sessionId: string) => void;
  onMarkChatRead?: (sessionId: string) => void;
  onMarkChatUnread?: (sessionId: string) => void;
  onMoveToProject?: (sessionId: string, projectId: string | null) => void;
  onNavigate?: (view: AppView) => void;
  onOpenProject?: (projectId: string) => void;
  onNewChat?: () => void;
  onNewChatInProject?: (projectId: string) => void;
  onRenameChat?: (sessionId: string, nextTitle: string) => void;
  onReorderProject?: (fromId: string, toId: string) => void;
  onSelectSession?: (sessionId: string) => void;
  onSessionSelectForScroll?: (sessionId: string) => void;
  onProjectCreatedRevisionHandled?: (revision: number) => void;
  projectCreatedRevision?: number;
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
    branchName,
    activityAt: sessionActivityAt(session),
    projectId: session.projectId ?? undefined,
    updatedAt: session.updatedAt,
    lastMessageAt: session.lastMessageAt,
    isRunning: isSessionRunning(runtime.chatState),
    hasUnread: runtime.hasUnread,
  };
}

function compareSessionsByPinnedThenActivityDesc(
  a: SidebarSessionItem,
  b: SidebarSessionItem,
  pinnedSessionIds: ReadonlySet<string>,
): number {
  const aIsPinned = pinnedSessionIds.has(a.id);
  const bIsPinned = pinnedSessionIds.has(b.id);
  if (aIsPinned !== bIsPinned) {
    return aIsPinned ? -1 : 1;
  }

  return compareSessionsByActivityDesc(a, b);
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

function orderFlatSessionListItems(
  sessions: SidebarSessionItem[],
  placeholderSessionIds: ReadonlySet<string>,
  pinnedSessionIds: ReadonlySet<string>,
): SidebarSessionItem[] {
  const pinnedSessions = sessions.filter((session) =>
    pinnedSessionIds.has(session.id),
  );
  const unpinnedSessions = sessions.filter(
    (session) => !pinnedSessionIds.has(session.id),
  );

  pinnedSessions.sort((a, b) =>
    compareSessionListItems(a, b, placeholderSessionIds),
  );

  return [
    ...pinnedSessions,
    ...limitFlatSidebarSessions(unpinnedSessions),
  ].slice(0, MAX_FLAT_SIDEBAR_CHATS);
}

function getSessionListGroups(
  visibleSessions: ChatSession[],
  projectIds: ReadonlySet<string>,
  sessionStateById: Record<string, SessionChatRuntime>,
  placeholderSessionIds: ReadonlySet<string>,
  branchNameBySessionId: ReadonlyMap<string, string>,
  pinnedSessionIds: ReadonlySet<string>,
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
    chats.sort((a, b) =>
      compareSessionListItems(a, b, placeholderSessionIds, pinnedSessionIds),
    );
  }

  const sortedStandalone = standalone.sort((a, b) =>
    compareSessionListItems(a, b, placeholderSessionIds, pinnedSessionIds),
  );
  const standalonePlaceholders = sortedStandalone.filter((session) =>
    placeholderSessionIds.has(session.id),
  );
  const standaloneNonPlaceholders = sortedStandalone.filter(
    (session) => !placeholderSessionIds.has(session.id),
  );
  const standaloneRecents = standaloneNonPlaceholders.slice(0, MAX_RECENTS);

  return {
    byProject,
    standalone: [...standalonePlaceholders, ...standaloneRecents],
    standaloneOverflow: standaloneNonPlaceholders.length > MAX_RECENTS,
  };
}

function compareSessionListItems(
  a: SidebarSessionItem,
  b: SidebarSessionItem,
  placeholderSessionIds: ReadonlySet<string>,
  pinnedSessionIds?: ReadonlySet<string>,
): number {
  const aIsPlaceholder = placeholderSessionIds.has(a.id);
  const bIsPlaceholder = placeholderSessionIds.has(b.id);
  if (aIsPlaceholder !== bIsPlaceholder) {
    return aIsPlaceholder ? -1 : 1;
  }

  return pinnedSessionIds
    ? compareSessionsByPinnedThenActivityDesc(a, b, pinnedSessionIds)
    : compareSessionsByActivityDesc(a, b);
}

function sessionHasTerminal(
  session: ChatSession,
  sessionIdsWithTerminals: ReadonlySet<string>,
): boolean {
  return (
    sessionIdsWithTerminals.has(session.id) ||
    Boolean(
      session.clientSessionId &&
        sessionIdsWithTerminals.has(session.clientSessionId),
    )
  );
}

function includeSessionListPlaceholderSessions(
  visibleSessions: ChatSession[],
  sessions: ChatSession[],
  nonEmptyDraftSessionIds: ReadonlySet<string>,
  sessionIdsWithTerminals: ReadonlySet<string>,
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
      nonEmptyDraftSessionIds.has(session.id) ||
      sessionHasTerminal(session, sessionIdsWithTerminals)
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
    pinned:
      typeof parsed.pinned === "boolean" ? parsed.pinned : defaults.pinned,
    projects:
      typeof parsed.projects === "boolean"
        ? parsed.projects
        : defaults.projects,
    recents:
      typeof parsed.recents === "boolean" ? parsed.recents : defaults.recents,
  };
}

export function validateDisplayOptions(
  value: unknown,
  defaults: SessionListDisplayOptions,
): SessionListDisplayOptions {
  if (!value || typeof value !== "object") return defaults;
  const parsed = value as Partial<
    Record<keyof SessionListDisplayOptions, unknown>
  > & {
    showChatIcons?: unknown;
    showTimestamps?: unknown;
    showProjectChatIcons?: unknown;
    showProjectTimestamps?: unknown;
  };
  const legacyShowChatIcons =
    typeof parsed.showChatIcons === "boolean" ? parsed.showChatIcons : null;
  const legacyShowTimestamps =
    typeof parsed.showTimestamps === "boolean" ? parsed.showTimestamps : null;
  const booleanOption = (
    value: unknown,
    legacy: boolean | null,
    fallback: boolean,
  ) => (typeof value === "boolean" ? value : (legacy ?? fallback));
  return {
    pinnedShowChatIcons: booleanOption(
      parsed.pinnedShowChatIcons,
      legacyShowChatIcons,
      defaults.pinnedShowChatIcons,
    ),
    pinnedShowTimestamps: booleanOption(
      parsed.pinnedShowTimestamps,
      legacyShowTimestamps,
      defaults.pinnedShowTimestamps,
    ),
    projectShowChatIcons: booleanOption(
      parsed.projectShowChatIcons,
      typeof parsed.showProjectChatIcons === "boolean"
        ? parsed.showProjectChatIcons
        : legacyShowChatIcons,
      defaults.projectShowChatIcons,
    ),
    projectShowTimestamps: booleanOption(
      parsed.projectShowTimestamps,
      typeof parsed.showProjectTimestamps === "boolean"
        ? parsed.showProjectTimestamps
        : legacyShowTimestamps,
      defaults.projectShowTimestamps,
    ),
    chatShowChatIcons: booleanOption(
      parsed.chatShowChatIcons,
      legacyShowChatIcons,
      defaults.chatShowChatIcons,
    ),
    chatShowTimestamps: booleanOption(
      parsed.chatShowTimestamps,
      legacyShowTimestamps,
      defaults.chatShowTimestamps,
    ),
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
  onForkChat,
  onMarkChatRead,
  onMarkChatUnread,
  onMoveToProject,
  onNavigate,
  onOpenProject,
  onNewChat,
  onNewChatInProject,
  onRenameChat,
  onReorderProject,
  onSelectSession,
  onSessionSelectForScroll,
  onProjectCreatedRevisionHandled,
  projectCreatedRevision = 0,
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
  const [displayOptions, setDisplayOptions] = usePersistedState(
    DISPLAY_OPTIONS_STORAGE_KEY,
    DEFAULT_DISPLAY_OPTIONS,
    validateDisplayOptions,
  );
  const [pinnedNavOrder, setPinnedNavOrder] = usePersistedState<string[]>(
    PINNED_NAV_ORDER_STORAGE_KEY,
    [],
    (value) =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [],
  );
  // Last chat toggled via cmd/ctrl-click; shift-click ranges extend from it.
  const selectionAnchorRef = useRef<string | null>(null);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const localMessageCountsBySession = useChatStore(
    useShallow(selectLocalMessageCountsBySession),
  );
  const nonEmptyDraftSessionIds = useChatStore(selectNonEmptyDraftSessionIds);
  const sessionIdsWithTerminals = useSyncExternalStore(
    subscribeTerminalSessionRegistry,
    getChatSessionIdsWithTerminals,
    () => new Set<string>(),
  );
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
  const { enabled: groupChatsByProject, setEnabled: setGroupChatsByProject } =
    useSidebarChatGroupingPreference();
  const [flatChatGroupNowMs, setFlatChatGroupNowMs] = useState(() =>
    Date.now(),
  );
  const attemptedChatLoadMoreCursorRef = useRef<string | null>(null);
  const hasFetchedProjects = useProjectStore(
    (state) => state.hasFetchedProjects,
  );
  const projectIds = useMemo(
    () => new Set(projects.map((project) => project.id)),
    [projects],
  );
  useEffect(() => {
    if (projectCreatedRevision === 0) return;
    setSectionVisibility((current) =>
      current.projects ? current : { ...current, projects: true },
    );
    onProjectCreatedRevisionHandled?.(projectCreatedRevision);
  }, [
    onProjectCreatedRevisionHandled,
    projectCreatedRevision,
    setSectionVisibility,
  ]);
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const visibleSessions = useMemo(
    () =>
      includeSessionListPlaceholderSessions(
        getVisibleSessions(sessions, localMessageCountsBySession),
        sessions,
        nonEmptyDraftSessionIds,
        sessionIdsWithTerminals,
        activeSessionId,
      ),
    [
      activeSessionId,
      localMessageCountsBySession,
      nonEmptyDraftSessionIds,
      sessionIdsWithTerminals,
      sessions,
    ],
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
    enabled: false,
  });
  const homeWidgetInstances = useHomeWidgetStore((state) => state.instances);
  const homeWidgetLoadStatus = useHomeWidgetStore((state) => state.loadStatus);
  const pinnedHomeChatSessionIdsInOrder = useMemo(
    () => getPinnedHomeChatSessionIdsInOrder(homeWidgetInstances),
    [homeWidgetInstances],
  );
  const pinnedHomeChatSessionIds = useMemo(
    () => new Set(pinnedHomeChatSessionIdsInOrder),
    [pinnedHomeChatSessionIdsInOrder],
  );
  const pinnedNavigationItems = useMemo(() => {
    const itemByKey = new Map<string, SidebarPinnedNavigationItem>();
    const sessionsById = new Map(
      activeSessions.map((session) => [session.id, session]),
    );
    for (const sessionId of pinnedHomeChatSessionIdsInOrder) {
      const session = sessionsById.get(sessionId);
      if (!session) continue;
      const item = toSessionListItem(
        session,
        sessionStateById,
        branchNameBySessionId,
      );
      itemByKey.set(`chat:${session.id}`, { kind: "chat", session: item });
    }

    const orderedKeys = [
      ...pinnedNavOrder.filter((key) => itemByKey.has(key)),
      ...Array.from(itemByKey.keys()).filter(
        (key) => !pinnedNavOrder.includes(key),
      ),
    ];
    return orderedKeys.flatMap((key) => {
      const item = itemByKey.get(key);
      return item ? [item] : [];
    });
  }, [
    activeSessions,
    branchNameBySessionId,
    pinnedHomeChatSessionIdsInOrder,
    pinnedNavOrder,
    sessionStateById,
  ]);
  useEffect(() => {
    const validKeys = new Set(
      Array.from(pinnedHomeChatSessionIds, (id) => `chat:${id}`),
    );
    setPinnedNavOrder((current) => {
      const next = current.filter((key) => validKeys.has(key));
      return next.length === current.length ? current : next;
    });
  }, [pinnedHomeChatSessionIds, setPinnedNavOrder]);

  useEffect(() => {
    if (homeWidgetLoadStatus !== "ready" || !hasFetchedProjects) return;
    for (const instance of homeWidgetInstances) {
      const isStaleProject =
        instance.type === "projectArtifactPin" &&
        typeof instance.state?.projectId === "string" &&
        !projectIds.has(instance.state.projectId.trim());
      if (isStaleProject) {
        useHomeWidgetStore.getState().removeWidget(instance.id);
      }
    }
  }, [
    hasFetchedProjects,
    homeWidgetInstances,
    homeWidgetLoadStatus,
    projectIds,
  ]);

  const reorderPinnedNavigationItem = useCallback(
    (fromKey: string, toKey: string, placement: "before" | "after") => {
      setPinnedNavOrder(() => {
        const current = pinnedNavigationItems.map(
          (item) => `chat:${item.session.id}`,
        );
        const fromIndex = current.indexOf(fromKey);
        const toIndex = current.indexOf(toKey);
        if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex)
          return current;
        const [moved] = current.splice(fromIndex, 1);
        const adjustedTarget = fromIndex < toIndex ? toIndex - 1 : toIndex;
        current.splice(
          placement === "after" ? adjustedTarget + 1 : adjustedTarget,
          0,
          moved,
        );
        return current;
      });
    },
    [pinnedNavigationItems, setPinnedNavOrder],
  );

  const selectedCount = selectedSessionIds.size;
  const isSelectionPinnedToHome = useMemo(
    () =>
      selectedCount > 0 &&
      [...selectedSessionIds].every((sessionId) =>
        pinnedHomeChatSessionIds.has(sessionId),
      ),
    [pinnedHomeChatSessionIds, selectedCount, selectedSessionIds],
  );
  const clearSelection = () => {
    selectionAnchorRef.current = null;
    setSelectedSessionIds(new Set());
  };

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
      selectionAnchorRef.current = null;
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

  const { pinBatchToHome, unpinBatchFromHome, isPinningBatch } =
    usePinBatchToHome();
  const handlePinSelectedToHome = useCallback(async () => {
    await pinBatchToHome("chat", Array.from(selectedSessionIds));
    selectionAnchorRef.current = null;
    setSelectedSessionIds(new Set());
  }, [pinBatchToHome, selectedSessionIds]);

  const handleUnpinSelectedFromHome = useCallback(() => {
    unpinBatchFromHome("chat", Array.from(selectedSessionIds));
    selectionAnchorRef.current = null;
    setSelectedSessionIds(new Set());
  }, [selectedSessionIds, unpinBatchFromHome]);

  const handleOpenSelectedInWindows = useCallback(() => {
    void applySelectionAction((sessionId) => {
      if (useSessionWindowStore.getState().isOpenInWindow(sessionId)) {
        return focusSessionWindow(sessionId);
      }
      const runtime = sessionStateById[sessionId];
      return openSessionWindow(sessionId, {
        handoff: runtime ? sessionNeedsWindowHandoff(runtime) : false,
      });
    });
  }, [applySelectionAction, sessionStateById]);

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

  const pinnedChatProjectIds = useMemo(
    () =>
      new Set(
        activeSessions
          .filter((session) => pinnedHomeChatSessionIds.has(session.id))
          .flatMap((session) => (session.projectId ? [session.projectId] : [])),
      ),
    [activeSessions, pinnedHomeChatSessionIds],
  );
  const projectSessions = useMemo(
    () =>
      groupChatsByProject
        ? getSessionListGroups(
            visibleSessions.sessions.filter(
              (session) => !pinnedHomeChatSessionIds.has(session.id),
            ),
            projectIds,
            sessionStateById,
            visibleSessions.placeholderSessionIds,
            branchNameBySessionId,
            pinnedHomeChatSessionIds,
          )
        : EMPTY_SESSION_LIST_GROUPS,
    [
      branchNameBySessionId,
      groupChatsByProject,
      pinnedHomeChatSessionIds,
      projectIds,
      sessionStateById,
      visibleSessions,
    ],
  );
  const flatSessionCandidates = useMemo(() => {
    if (groupChatsByProject) return [];
    return getFlatSessionListItems(
      visibleSessions.sessions.filter(
        (session) => !pinnedHomeChatSessionIds.has(session.id),
      ),
      projectsById,
      sessionStateById,
      visibleSessions.placeholderSessionIds,
      branchNameBySessionId,
    );
  }, [
    branchNameBySessionId,
    groupChatsByProject,
    pinnedHomeChatSessionIds,
    projectsById,
    sessionStateById,
    visibleSessions,
  ]);
  const flatSessions = useMemo(
    () =>
      orderFlatSessionListItems(
        flatSessionCandidates,
        visibleSessions.placeholderSessionIds,
        pinnedHomeChatSessionIds,
      ),
    [
      flatSessionCandidates,
      pinnedHomeChatSessionIds,
      visibleSessions.placeholderSessionIds,
    ],
  );
  const flatChatGroups = useMemo(
    () =>
      groupChatsByProject
        ? []
        : groupFlatChatsByActivityAge(
            flatSessions,
            flatChatGroupNowMs,
            pinnedHomeChatSessionIds,
          ),
    [
      flatChatGroupNowMs,
      flatSessions,
      groupChatsByProject,
      pinnedHomeChatSessionIds,
    ],
  );

  const hasFlatChatOverflow =
    flatSessionCandidates.length > MAX_FLAT_SIDEBAR_CHATS || hasMoreSessions;
  const standaloneChatCount = groupChatsByProject
    ? projectSessions.standalone.length
    : flatSessionCandidates.length;
  const groupedChatCount = useMemo(
    () =>
      projectSessions.standalone.length +
      Object.values(projectSessions.byProject).reduce(
        (count, chats) => count + chats.length,
        0,
      ),
    [projectSessions],
  );
  const reachedAutoLoadLimit = groupChatsByProject
    ? standaloneChatCount >= MAX_FLAT_SIDEBAR_CHATS ||
      groupedChatCount >= MAX_AUTO_LOADED_GROUPED_CHATS
    : standaloneChatCount >= MAX_FLAT_SIDEBAR_CHATS;
  const chatLoadMoreCursorKey = sessionPageCursor ?? "__initial__";

  useEffect(() => {
    if (
      surface.preview ||
      !hasMoreSessions ||
      isLoadingMoreSessions ||
      reachedAutoLoadLimit
    ) {
      return;
    }
    if (attemptedChatLoadMoreCursorRef.current === chatLoadMoreCursorKey) {
      return;
    }

    attemptedChatLoadMoreCursorRef.current = chatLoadMoreCursorKey;
    void loadMoreSessions();
  }, [
    chatLoadMoreCursorKey,
    hasMoreSessions,
    isLoadingMoreSessions,
    loadMoreSessions,
    reachedAutoLoadLimit,
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
  const setDisplayOption =
    (key: keyof SessionListDisplayOptions) => (value: boolean) => {
      setDisplayOptions((prev) => ({ ...prev, [key]: value }));
    };
  const toggleSessionSelection = (sessionId: string, selected: boolean) => {
    selectionAnchorRef.current = selected ? sessionId : null;
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

  const rangeSelectSessions = (sessionId: string) => {
    const current = selectedSessionIds;
    // With no selection yet, the active chat acts as the implicit anchor so
    // shift-click selects everything between it and the clicked chat.
    const seedActiveId =
      current.size === 0 &&
      activeSessionId &&
      activeSessionIds.has(activeSessionId)
        ? activeSessionId
        : null;
    const anchorId = selectionAnchorRef.current ?? seedActiveId;
    const next = getSessionRangeSelection({
      current: seedActiveId ? new Set([seedActiveId]) : current,
      anchorId,
      targetId: sessionId,
      orderedIds: getRenderedSessionIdsInOrder(),
    });
    selectionAnchorRef.current = anchorId ?? sessionId;
    setSelectedSessionIds((prev) => (areSetsEqual(next, prev) ? prev : next));
  };

  const sectionProps: SidebarProjectsSectionProps = {
    projects,
    pinnedNavigationItems,
    onReorderPinnedNavigationItem: reorderPinnedNavigationItem,
    pinnedChatProjectIds,
    projectSessions,
    hasVisibleChats: activeSessions.length > 0,
    flatChatGroups,
    hasFlatChatOverflow,
    groupChatsByProject,
    onGroupChatsByProjectChange: setGroupChatsByProject,
    pinnedShowChatIcons: displayOptions.pinnedShowChatIcons,
    onPinnedShowChatIconsChange: setDisplayOption("pinnedShowChatIcons"),
    pinnedShowTimestamps: displayOptions.pinnedShowTimestamps,
    onPinnedShowTimestampsChange: setDisplayOption("pinnedShowTimestamps"),
    projectShowChatIcons: displayOptions.projectShowChatIcons,
    onProjectShowChatIconsChange: setDisplayOption("projectShowChatIcons"),
    projectShowTimestamps: displayOptions.projectShowTimestamps,
    onProjectShowTimestampsChange: setDisplayOption("projectShowTimestamps"),
    chatShowChatIcons: displayOptions.chatShowChatIcons,
    onChatShowChatIconsChange: setDisplayOption("chatShowChatIcons"),
    chatShowTimestamps: displayOptions.chatShowTimestamps,
    onChatShowTimestampsChange: setDisplayOption("chatShowTimestamps"),
    expandedProjects,
    toggleProject,
    collapsed,
    labelTransition,
    labelVisible,
    activeSessionId,
    onNavigate,
    onOpenProject,
    onSelectSession: selectSession,
    onNewChatInProject,
    onNewChat,
    onCreateProject,
    onEditProject,
    onForkChat,
    onArchiveProject,
    onArchiveChat: onArchiveChat
      ? (sessionId) =>
          Promise.resolve(onArchiveChat(sessionId)).then(() => undefined)
      : undefined,
    onRenameChat,
    onMarkChatRead,
    onMarkChatUnread,
    onMoveToProject,
    selectedSessionIds,
    selectionEnabled: selectedCount > 0,
    selectionActionsDisabled: isApplyingSelectionAction,
    onSelectionClear: clearSelection,
    onSelectionChange: toggleSessionSelection,
    onRangeSelect: rangeSelectSessions,
    onArchiveSelected: requestArchiveSelected,
    onPinSelectedToHome: handlePinSelectedToHome,
    onUnpinSelectedFromHome: handleUnpinSelectedFromHome,
    isSelectionPinnedToHome,
    onOpenSelectedInWindows: handleOpenSelectedInWindows,
    isPinningSelectedToHome: isPinningBatch,
    onMarkSelectedRead: () => void applySelectionAction(onMarkChatRead),
    onMarkSelectedUnread: () => void applySelectionAction(onMarkChatUnread),
    onReorderProject,
    hasMoreSessions,
    pinnedSectionOpen: sectionVisibility.pinned,
    projectsSectionOpen: sectionVisibility.projects,
    recentsSectionOpen: sectionVisibility.recents,
    onTogglePinnedSection: () => toggleSection("pinned"),
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
          destructive={false}
          loadingLabel={t("common:bulkActions.archiving")}
          isLoading={isApplyingSelectionAction}
          onConfirm={() => confirmArchiveSelected(onArchiveChat)}
        />
      )}
    </>
  );
}
