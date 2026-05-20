import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  IconBolt,
  IconHistory,
  IconHome,
  IconArrowLeft,
  IconPalette,
  IconRobotFace,
  IconSearch,
  IconSettings,
} from "@tabler/icons-react";
import { SkillIcon } from "@/features/skills/ui/SkillIcon";
import { getDisplaySessionTitle } from "@/features/chat/lib/sessionTitle";
import { GooseIcon } from "@/shared/ui/icons/GooseIcon";
import { cn } from "@/shared/lib/cn";
import type { AppView } from "@/app/AppShell";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  selectMessagesBySession,
  selectSessionStateById,
} from "@/features/chat/stores/chatSelectors";
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";
import type { SessionChatRuntime } from "@/shared/types/chat";
import {
  getVisibleSessions,
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { selectSessions } from "@/features/chat/stores/chatSessionSelectors";
import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import {
  areSetsEqual,
  normalizeSelectedSessionIds,
  toggleSessionSelection as getToggledSessionSelection,
} from "@/features/sessions/lib/sessionSelection";
import { useBulkSessionActions } from "@/features/sessions/hooks/useBulkSessionActions";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { selectProjects } from "@/features/projects/stores/projectSelectors";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { useSessionSearch } from "@/features/sessions/hooks/useSessionSearch";
import { SIDE_PANEL_DEFAULT_WIDTH } from "@/shared/constants/panels";
import { usePersistedState } from "@/shared/hooks/usePersistedState";
import { SidebarPinnedSection } from "./SidebarPinnedSection";
import { SidebarProjectsSection } from "./SidebarProjectsSection";
import type { SidebarSessionItem } from "./SidebarProjectSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarSearchResults } from "./SidebarSearchResults";
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
  type SectionId,
} from "@/features/settings/ui/settingsSections";
import { isDesignSystemExplorerEnabled } from "@/features/design-system/lib/designSystemEnabled";
import {
  DEFAULT_DESIGN_SYSTEM_SECTION,
  DESIGN_SYSTEM_COMPONENT_SECTIONS,
  DESIGN_SYSTEM_CORE_SECTIONS,
  DESIGN_SYSTEM_UNUSED_COMPONENT_SECTIONS,
  type DesignSystemSection,
} from "@/features/design-system/ui/designSystemSections";

interface SidebarProps {
  collapsed: boolean;
  width?: number;
  isResizing?: boolean;
  onSettingsClick?: () => void;
  onSettingsBack?: () => void;
  onSettingsSectionChange?: (section: SectionId) => void;
  onDesignSystemBack?: () => void;
  onDesignSystemSectionChange?: (section: DesignSystemSection) => void;
  onNewChatInProject?: (projectId: string) => void;
  onNewChat?: () => void;
  onCreateProject?: () => void;
  onEditProject?: (projectId: string) => void;
  onArchiveProject?: (projectId: string) => void;
  onArchiveChat?: (sessionId: string) => void | Promise<void>;
  onRenameChat?: (sessionId: string, nextTitle: string) => void;
  onMarkChatRead?: (sessionId: string) => void;
  onMarkChatUnread?: (sessionId: string) => void;
  onMoveToProject?: (sessionId: string, projectId: string | null) => void;
  onReorderProject?: (fromId: string, toId: string) => void;
  onNavigate?: (view: AppView) => void;
  onSelectSession?: (sessionId: string) => void;
  onSelectSearchResult?: (
    sessionId: string,
    messageId?: string,
    query?: string,
  ) => void;
  activeView?: AppView;
  activeSettingsSection?: SectionId;
  activeDesignSystemSection?: DesignSystemSection;
  activeSessionId?: string | null;
  className?: string;
  projects: ProjectInfo[];
}

const EXPANDED_PROJECTS_STORAGE_KEY = "goose:sidebar:expanded-projects";
const SECTION_VISIBILITY_STORAGE_KEY = "goose:sidebar:section-visibility";
const MAX_RECENTS = 20;
type SidebarSectionVisibility = {
  projects: boolean;
  recents: boolean;
};
const DEFAULT_SECTION_VISIBILITY: SidebarSectionVisibility = {
  projects: true,
  recents: true,
};

type SidebarSessionGroups = {
  byProject: Record<string, SidebarSessionItem[]>;
  standalone: SidebarSessionItem[];
};

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

function toSidebarSessionItem(
  session: ChatSession,
  sessionStateById: Record<string, SessionChatRuntime>,
): SidebarSessionItem {
  const runtime = sessionStateById[session.id] ?? INITIAL_SESSION_CHAT_RUNTIME;
  return {
    id: session.id,
    title: session.title,
    projectId: session.projectId ?? undefined,
    updatedAt: session.updatedAt,
    isRunning: isSessionRunning(runtime.chatState),
    hasUnread: runtime.hasUnread,
  };
}

function getSidebarSessionGroups(
  visibleSessions: ChatSession[],
  projectIds: ReadonlySet<string>,
  sessionStateById: Record<string, SessionChatRuntime>,
): SidebarSessionGroups {
  const byProject: Record<string, SidebarSessionItem[]> = {};
  const standalone: SidebarSessionItem[] = [];

  for (const session of visibleSessions) {
    if (session.archivedAt) continue;
    const item = toSidebarSessionItem(session, sessionStateById);
    if (session.projectId && projectIds.has(session.projectId)) {
      byProject[session.projectId] ??= [];
      byProject[session.projectId].push(item);
    } else {
      standalone.push(item);
    }
  }

  for (const chats of Object.values(byProject)) {
    chats.sort(compareSessionsByUpdatedAtDesc);
  }

  return {
    byProject,
    standalone: standalone
      .sort(compareSessionsByUpdatedAtDesc)
      .slice(0, MAX_RECENTS),
  };
}

function getLoadedVisibleSessions(): ChatSession[] {
  const sessionState = useChatSessionStore.getState();
  const chatState = useChatStore.getState();
  return getVisibleSessions(sessionState.sessions, chatState.messagesBySession);
}

function getLoadedActiveSessions(): ChatSession[] {
  return getLoadedVisibleSessions().filter((session) => !session.archivedAt);
}

function validateSectionVisibility(
  value: unknown,
  defaults: SidebarSectionVisibility,
): SidebarSectionVisibility {
  if (!value || typeof value !== "object") return defaults;
  const parsed = value as Partial<
    Record<keyof SidebarSectionVisibility, unknown>
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

export function Sidebar({
  collapsed,
  width = SIDE_PANEL_DEFAULT_WIDTH,
  isResizing = false,
  onSettingsClick,
  onSettingsBack,
  onSettingsSectionChange,
  onDesignSystemBack,
  onDesignSystemSectionChange,
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
  onReorderProject,
  onNavigate,
  onSelectSession,
  onSelectSearchResult,
  activeView,
  activeSettingsSection = DEFAULT_SETTINGS_SECTION,
  activeDesignSystemSection = DEFAULT_DESIGN_SYSTEM_SECTION,
  activeSessionId,
  className,
  projects,
}: SidebarProps) {
  const { t, i18n } = useTranslation(["sidebar", "common", "settings"]);
  const [expanded, setExpanded] = useState(!collapsed);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const prevCollapsed = useRef(collapsed);
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
  const sessionStateById = useChatStore(selectSessionStateById);
  const sessions = useChatSessionStore(selectSessions);
  const hasMoreSessions = useChatSessionStore((s) => s.hasMoreSessions);
  const isLoadingMoreSessions = useChatSessionStore(
    (s) => s.isLoadingMoreSessions,
  );
  const loadMoreSessions = useChatSessionStore((s) => s.loadMoreSessions);
  const getPersonaById = useAgentStore((s) => s.getPersonaById);
  const projectStoreProjects = useProjectStore(selectProjects);
  const projectIds = useMemo(
    () => new Set(projects.map((project) => project.id)),
    [projects],
  );
  const visibleSessions = useMemo(
    () => getVisibleSessions(sessions, messagesBySession),
    [messagesBySession, sessions],
  );
  const activeSessions = useMemo(
    () => visibleSessions.filter((session) => !session.archivedAt),
    [visibleSessions],
  );
  const activeSessionIds = useMemo(
    () => new Set(activeSessions.map((session) => session.id)),
    [activeSessions],
  );
  const selectedCount = selectedSessionIds.size;
  const clearSelection = () => setSelectedSessionIds(new Set());
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
    if (collapsed) {
      setExpanded(false);
    } else if (prevCollapsed.current && !collapsed) {
      const timer = setTimeout(() => setExpanded(true), 60);
      return () => clearTimeout(timer);
    } else {
      setExpanded(true);
    }
    prevCollapsed.current = collapsed;
  }, [collapsed]);

  const labelTransition = "transition-[opacity,width] duration-300 ease-out";
  const labelVisible = expanded && !collapsed;
  const isSettingsSurface = activeView === "settings";
  const isDesignSystemSurface = activeView === "design-system";
  const isSecondarySurface = isSettingsSurface || isDesignSystemSurface;
  const defaultTitle = t("common:session.defaultTitle");
  const getDisplayTitle = useCallback(
    (session: { title: string }) =>
      getDisplaySessionTitle(session.title, defaultTitle),
    [defaultTitle],
  );
  const navItems: readonly {
    id: AppView;
    label: string;
    icon: typeof IconRobotFace;
  }[] = [
    { id: "agents", label: t("navigation.agents"), icon: IconRobotFace },
    { id: "skills", label: t("navigation.skills"), icon: SkillIcon },
    { id: "automations", label: t("navigation.automations"), icon: IconBolt },
    {
      id: "session-history",
      label: t("navigation.sessionHistory"),
      icon: IconHistory,
    },
    ...(isDesignSystemExplorerEnabled()
      ? [
          {
            id: "design-system" as const,
            label: "Design system (dev only)",
            icon: IconPalette,
          },
        ]
      : []),
  ];

  const projectSessions = useMemo(
    () =>
      getSidebarSessionGroups(visibleSessions, projectIds, sessionStateById),
    [projectIds, sessionStateById, visibleSessions],
  );

  const projectNamesById = useMemo(
    () =>
      new Map(
        projectStoreProjects.map((project) => [project.id, project.name]),
      ),
    [projectStoreProjects],
  );
  const sidebarResolvers = useMemo(
    () => ({
      getPersonaName: (personaId: string) =>
        getPersonaById(personaId)?.displayName,
      getProjectName: (projectId: string) => projectNamesById.get(projectId),
    }),
    [getPersonaById, projectNamesById],
  );
  const sidebarSearch = useSessionSearch({
    sessions: activeSessions,
    resolvers: sidebarResolvers,
    locale: i18n.resolvedLanguage,
    getDisplayTitle,
  });
  const {
    isSearching: isSidebarSearching,
    query: sidebarSearchQuery,
    results: sidebarSearchResults,
    search: submitSidebarSearch,
    searchMore: searchMoreLoadedSidebarChats,
    setQuery: setSidebarSearchQuery,
    submittedQuery: submittedSidebarSearchQuery,
    error: sidebarSearchError,
  } = sidebarSearch;

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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "k" && e.metaKey) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const toggleProject = useCallback((projectId: string) => {
    setExpandedProjects((prev) => ({
      ...prev,
      [projectId]: !prev[projectId],
    }));
  }, []);
  const searchMoreSidebarChats = useCallback(async () => {
    const state = useChatSessionStore.getState();
    if (
      !submittedSidebarSearchQuery ||
      !state.hasMoreSessions ||
      state.isLoadingMoreSessions ||
      isSidebarSearching
    ) {
      return;
    }

    await loadMoreSessions();
    await searchMoreLoadedSidebarChats(getLoadedActiveSessions());
  }, [
    isSidebarSearching,
    loadMoreSessions,
    searchMoreLoadedSidebarChats,
    submittedSidebarSearchQuery,
  ]);
  const toggleSection = (section: keyof SidebarSectionVisibility) => {
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

  return (
    <div
      className={cn(
        "relative h-full",
        !isResizing && "transition-[width] duration-300 ease-in-out",
        className,
      )}
      style={{ width }}
    >
      <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-surface-chrome backdrop-blur-md">
        <div
          className={cn(
            "flex-shrink-0 pt-[8px]",
            collapsed ? "px-1.5 pb-1.5" : "px-3 pb-1",
          )}
        >
          <div
            className={cn(
              "flex items-center",
              collapsed ? "justify-center" : "justify-between",
            )}
          >
            <GooseIcon className="text-foreground" />
          </div>
        </div>

        <div className="relative flex-1 min-h-0 overflow-hidden">
          <div
            className={cn(
              "absolute inset-0 flex flex-col transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none",
              isSecondarySurface
                ? "pointer-events-none -translate-x-full opacity-0"
                : "translate-x-0 opacity-100",
            )}
            inert={isSecondarySurface ? true : undefined}
            aria-hidden={isSecondarySurface}
          >
            <nav
              className={cn(
                "relative h-full overflow-y-auto overflow-x-hidden px-1.5 py-1 pt-1 scrollbar-none",
                collapsed ? "pb-16" : "pb-[72px]",
              )}
              style={{
                maskImage:
                  "linear-gradient(to bottom, black calc(100% - 5rem), transparent 100%)",
                WebkitMaskImage:
                  "linear-gradient(to bottom, black calc(100% - 5rem), transparent 100%)",
              }}
              aria-label={t("navigation.main")}
            >
              <div className="relative z-10 space-y-0.5">
                <div
                  className={cn(
                    "mb-3 flex items-center w-full rounded-md transition-all duration-300 ease-out",
                    collapsed
                      ? "justify-center p-3 text-foreground"
                      : "gap-2 border border-border px-2.5 py-1.5 text-xs text-foreground hover:text-foreground hover:bg-transparent",
                  )}
                >
                  <IconSearch className="size-3.5 flex-shrink-0 text-placeholder" />
                  {!collapsed && (
                    <input
                      ref={searchInputRef}
                      type="text"
                      enterKeyHint="search"
                      value={sidebarSearchQuery}
                      onChange={(e) => setSidebarSearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void submitSidebarSearch();
                        }
                      }}
                      placeholder={t("search.placeholder")}
                      className={cn(
                        "focus-override appearance-none bg-transparent border-none text-xs flex-1 min-w-0 placeholder:text-placeholder outline-none focus-visible:ring-0 focus-visible:ring-offset-0",
                        labelTransition,
                        labelVisible
                          ? "opacity-100 w-auto"
                          : "opacity-0 w-0 overflow-hidden",
                      )}
                      onClick={(e) => e.stopPropagation()}
                    />
                  )}
                </div>

                <SidebarNavItem
                  testId="nav-home"
                  icon={IconHome}
                  label={t("navigation.home")}
                  collapsed={collapsed}
                  labelTransition={labelTransition}
                  labelVisible={labelVisible}
                  isActive={activeView === "home"}
                  onClick={() => onNavigate?.("home")}
                />

                {navItems.map((item, index) => {
                  const isActive = activeView === item.id;
                  return (
                    <SidebarNavItem
                      key={item.id}
                      icon={item.icon}
                      label={item.label}
                      collapsed={collapsed}
                      labelTransition={labelTransition}
                      labelVisible={labelVisible}
                      isActive={isActive}
                      onClick={() => onNavigate?.(item.id)}
                      labelTransitionDelay={
                        labelVisible ? `${index * 30 + 60}ms` : "0ms"
                      }
                    />
                  );
                })}
              </div>

              {!collapsed && <SidebarPinnedSection />}

              {!collapsed &&
                (submittedSidebarSearchQuery ? (
                  <div className="relative z-10 space-y-2">
                    {sidebarSearchError && (
                      <p className="px-1 text-xs text-text-danger">
                        {t("search.error")}
                      </p>
                    )}

                    {isSidebarSearching &&
                      sidebarSearchResults.length === 0 && (
                        <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                          {t("search.searching")}
                        </div>
                      )}

                    {(!isSidebarSearching ||
                      sidebarSearchResults.length > 0) && (
                      <SidebarSearchResults
                        results={sidebarSearchResults}
                        activeSessionId={activeSessionId}
                        onSelectResult={(sessionId, messageId) => {
                          if (messageId) {
                            onSelectSearchResult?.(
                              sessionId,
                              messageId,
                              submittedSidebarSearchQuery,
                            );
                            return;
                          }
                          onSelectSession?.(sessionId);
                        }}
                        getPersonaName={sidebarResolvers.getPersonaName}
                        getProjectName={sidebarResolvers.getProjectName}
                      />
                    )}

                    {hasMoreSessions && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => void searchMoreSidebarChats()}
                        disabled={isLoadingMoreSessions || isSidebarSearching}
                        className="h-auto w-full justify-start rounded-md px-3 py-1.5 text-[11px] text-foreground hover:text-foreground"
                      >
                        {isLoadingMoreSessions || isSidebarSearching
                          ? t("search.loadingMore")
                          : t("search.searchMore")}
                      </Button>
                    )}
                  </div>
                ) : (
                  <SidebarProjectsSection
                    projects={projects}
                    projectSessions={projectSessions}
                    hasVisibleChats={activeSessions.length > 0}
                    expandedProjects={expandedProjects}
                    toggleProject={toggleProject}
                    collapsed={collapsed}
                    labelTransition={labelTransition}
                    labelVisible={labelVisible}
                    activeSessionId={activeSessionId}
                    onNavigate={onNavigate}
                    onSelectSession={onSelectSession}
                    onNewChatInProject={onNewChatInProject}
                    onNewChat={onNewChat}
                    onCreateProject={onCreateProject}
                    onEditProject={onEditProject}
                    onArchiveProject={onArchiveProject}
                    onArchiveChat={onArchiveChat}
                    onRenameChat={onRenameChat}
                    onMarkChatRead={onMarkChatRead}
                    onMarkChatUnread={onMarkChatUnread}
                    onMoveToProject={onMoveToProject}
                    selectedSessionIds={selectedSessionIds}
                    selectionEnabled={selectedCount > 0}
                    selectionActionsDisabled={isApplyingSelectionAction}
                    onSelectionClear={clearSelection}
                    onSelectionChange={toggleSessionSelection}
                    onArchiveSelected={requestArchiveSelected}
                    onMarkSelectedRead={() =>
                      void applySelectionAction(onMarkChatRead)
                    }
                    onMarkSelectedUnread={() =>
                      void applySelectionAction(onMarkChatUnread)
                    }
                    onReorderProject={onReorderProject}
                    hasMoreSessions={hasMoreSessions}
                    projectsSectionOpen={sectionVisibility.projects}
                    recentsSectionOpen={sectionVisibility.recents}
                    onToggleProjectsSection={() => toggleSection("projects")}
                    onToggleRecentsSection={() => toggleSection("recents")}
                  />
                ))}
            </nav>

            <div
              className={cn(
                "absolute inset-x-0 bottom-0 z-20",
                "px-1.5 py-1.5",
              )}
            >
              <Button
                type="button"
                variant="ghost"
                size={collapsed ? "icon-sm" : "default"}
                onClick={onSettingsClick}
                className={cn(
                  "h-10 w-full rounded-md bg-transparent text-text-muted hover:bg-transparent hover:text-foreground active:bg-transparent",
                  collapsed
                    ? "justify-center p-3"
                    : "justify-start gap-2.5 px-3 py-2.5",
                )}
                title={t("settings:title")}
                aria-label={t("settings:title")}
              >
                <IconSettings className="size-4 flex-shrink-0" />
                {!collapsed && (
                  <span
                    className={cn(
                      "whitespace-nowrap text-sm",
                      labelTransition,
                      labelVisible
                        ? "opacity-100 w-auto"
                        : "opacity-0 w-0 overflow-hidden",
                    )}
                  >
                    {t("settings:title")}
                  </span>
                )}
              </Button>
            </div>
          </div>

          <div
            className={cn(
              "absolute inset-0 flex flex-col transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none",
              isSecondarySurface
                ? "translate-x-0 opacity-100"
                : "pointer-events-none translate-x-full opacity-0",
            )}
            inert={!isSecondarySurface ? true : undefined}
            aria-hidden={!isSecondarySurface}
          >
            <nav
              className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 py-1 scrollbar-none"
              aria-label={
                isSettingsSurface
                  ? t("settings:navigationLabel")
                  : "Design system navigation"
              }
            >
              <div className="space-y-0.5">
                {isSettingsSurface ? (
                  SETTINGS_SECTIONS.map((item, index) => (
                    <SidebarNavItem
                      key={item.id}
                      icon={item.icon}
                      label={t(`settings:${item.labelKey}`)}
                      collapsed={collapsed}
                      labelTransition={labelTransition}
                      labelVisible={labelVisible}
                      isActive={activeSettingsSection === item.id}
                      onClick={() => onSettingsSectionChange?.(item.id)}
                      labelTransitionDelay={
                        labelVisible ? `${index * 30 + 60}ms` : "0ms"
                      }
                    />
                  ))
                ) : (
                  <>
                    {DESIGN_SYSTEM_CORE_SECTIONS.map((item, index) => (
                      <SidebarNavItem
                        key={item.id}
                        label={item.label}
                        collapsed={collapsed}
                        labelTransition={labelTransition}
                        labelVisible={labelVisible}
                        isActive={activeDesignSystemSection === item.id}
                        onClick={() => onDesignSystemSectionChange?.(item.id)}
                        labelTransitionDelay={
                          labelVisible ? `${index * 30 + 60}ms` : "0ms"
                        }
                      />
                    ))}
                    {!collapsed && (
                      <div
                        className={cn(
                          "px-3 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
                          labelTransition,
                          labelVisible
                            ? "opacity-100"
                            : "opacity-0 overflow-hidden",
                        )}
                      >
                        {t("sections.components")}
                      </div>
                    )}
                    {DESIGN_SYSTEM_COMPONENT_SECTIONS.map((item, index) => (
                      <SidebarNavItem
                        key={item.id}
                        label={item.label}
                        collapsed={collapsed}
                        labelTransition={labelTransition}
                        labelVisible={labelVisible}
                        isActive={activeDesignSystemSection === item.id}
                        onClick={() => onDesignSystemSectionChange?.(item.id)}
                        labelTransitionDelay={
                          labelVisible
                            ? `${(DESIGN_SYSTEM_CORE_SECTIONS.length + index) * 30 + 60}ms`
                            : "0ms"
                        }
                      />
                    ))}
                    {!collapsed && (
                      <div
                        className={cn(
                          "px-3 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
                          labelTransition,
                          labelVisible
                            ? "opacity-100"
                            : "opacity-0 overflow-hidden",
                        )}
                      >
                        {t("sections.notUsed")}
                      </div>
                    )}
                    {DESIGN_SYSTEM_UNUSED_COMPONENT_SECTIONS.map(
                      (item, index) => (
                        <SidebarNavItem
                          key={item.id}
                          label={item.label}
                          collapsed={collapsed}
                          labelTransition={labelTransition}
                          labelVisible={labelVisible}
                          isActive={activeDesignSystemSection === item.id}
                          onClick={() => onDesignSystemSectionChange?.(item.id)}
                          labelTransitionDelay={
                            labelVisible
                              ? `${(DESIGN_SYSTEM_CORE_SECTIONS.length + DESIGN_SYSTEM_COMPONENT_SECTIONS.length + index) * 30 + 60}ms`
                              : "0ms"
                          }
                        />
                      ),
                    )}
                  </>
                )}
              </div>
            </nav>
            <div className={cn("flex-shrink-0", "px-1.5 py-1.5")}>
              <Button
                type="button"
                variant="ghost"
                size={collapsed ? "icon-sm" : "default"}
                onClick={
                  isSettingsSurface ? onSettingsBack : onDesignSystemBack
                }
                className={cn(
                  "h-10 w-full rounded-md bg-transparent text-text-muted hover:bg-transparent hover:text-foreground active:bg-transparent",
                  collapsed
                    ? "justify-center p-3"
                    : "justify-start gap-2.5 px-3 py-2.5",
                )}
                title={t("actions.backToMainNavigation")}
                aria-label={t("actions.backToMainNavigation")}
              >
                <IconArrowLeft className="size-4 flex-shrink-0" />
                {!collapsed && (
                  <span
                    className={cn(
                      "whitespace-nowrap text-sm",
                      labelTransition,
                      labelVisible
                        ? "opacity-100 w-auto"
                        : "opacity-0 w-0 overflow-hidden",
                    )}
                  >
                    {t("actions.backToMainNavigation")}
                  </span>
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>
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
        onConfirm={() => confirmArchiveSelected(onArchiveChat)}
      />
    </div>
  );
}
