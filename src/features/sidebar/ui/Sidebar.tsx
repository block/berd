import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { IconArrowLeft, IconPalette } from "@tabler/icons-react";
import {
  SidebarNavAgentsIcon,
  SidebarNavAutomationsIcon,
  SidebarNavChatsIcon,
  SidebarNavHomeIcon,
  SidebarNavSettingsIcon,
  SidebarNavSkillsIcon,
} from "./sidebarNavIcons";
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
import { usePinBatchToHome } from "@/features/home/hooks/usePinToHomeWidget";
import { Button } from "@/shared/ui/button";
import { Switch } from "@/shared/ui/switch";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { usePersistedState } from "@/shared/hooks/usePersistedState";
import { SidebarPinnedSection } from "./SidebarPinnedSection";
import { SidebarProjectsSection } from "./SidebarProjectsSection";
import type { SidebarSessionItem } from "./SidebarProjectSection";
import {
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
  SIDEBAR_NAV_MICRO_LABEL_TEXT_CLASS,
  SIDEBAR_NAV_TEXT_CLASS,
  SIDEBAR_PANEL_ELEVATED_SHADOW_CLASS,
} from "@/shared/ui/sidebar-tokens";
import { SidebarNavItem } from "./SidebarNavItem";
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

type SidebarNavItemIcon = NonNullable<
  ComponentProps<typeof SidebarNavItem>["icon"]
>;

interface SidebarProps {
  collapsed: boolean;
  width: number;
  isResizing?: boolean;
  /** Drop shadow on the panel when hovering the sidebar (or actively resizing). */
  elevatedShadow?: boolean;
  onSettingsClick?: () => void;
  onSettingsBack?: () => void;
  onSettingsSectionChange?: (section: SectionId) => void;
  onDesignSystemBack?: () => void;
  onDesignSystemSectionChange?: (section: DesignSystemSection) => void;
  designSystemInspectorVisible?: boolean;
  onDesignSystemInspectorVisibleChange?: (visible: boolean) => void;
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
// Height of the nav's bottom fade mask. Shared by the mask style and the
// scroll-into-view math so a row never lands underneath the fade.
const BOTTOM_MASK_PX = 48;
const BOTTOM_MASK = `linear-gradient(to bottom, black calc(100% - ${BOTTOM_MASK_PX}px), transparent 100%)`;
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

function SidebarInspectorToggleNavItem({
  checked,
  collapsed,
  label,
  labelTransition,
  labelTransitionDelay,
  labelVisible,
  onCheckedChange,
  switchLabel,
}: {
  checked: boolean;
  collapsed: boolean;
  label: string;
  labelTransition: string;
  labelTransitionDelay?: string;
  labelVisible: boolean;
  onCheckedChange?: (checked: boolean) => void;
  switchLabel: string;
}) {
  return (
    <div
      className={cn(
        "flex w-full items-center rounded-md text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground",
        SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
        SIDEBAR_NAV_TEXT_CLASS,
        collapsed
          ? "justify-center px-3 py-2"
          : "justify-between gap-2.5 px-3 py-1.5",
      )}
      title={collapsed ? label : undefined}
    >
      <span
        className={cn(
          "min-w-0 whitespace-nowrap",
          labelTransition,
          labelVisible ? "opacity-100 w-auto" : "opacity-0 w-0 overflow-hidden",
        )}
        style={{ transitionDelay: labelTransitionDelay }}
      >
        {label}
      </span>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={switchLabel}
      />
    </div>
  );
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
  width,
  isResizing = false,
  elevatedShadow = false,
  onSettingsClick,
  onSettingsBack,
  onSettingsSectionChange,
  onDesignSystemBack,
  onDesignSystemSectionChange,
  designSystemInspectorVisible = false,
  onDesignSystemInspectorVisibleChange,
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
  activeView,
  activeSettingsSection = DEFAULT_SETTINGS_SECTION,
  activeDesignSystemSection = DEFAULT_DESIGN_SYSTEM_SECTION,
  activeSessionId,
  className,
  projects,
}: SidebarProps) {
  const { t } = useTranslation(["sidebar", "common", "settings"]);
  const navRef = useRef<HTMLElement>(null);
  const skipActiveSessionScrollRef = useRef<string | null>(null);
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

  const selectSessionFromSidebar = useCallback(
    (sessionId: string) => {
      skipActiveSessionScrollRef.current = sessionId;
      onSelectSession?.(sessionId);
    },
    [onSelectSession],
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

  const labelVisible = !collapsed;
  const labelTransition = "";
  const isSettingsSurface = activeView === "settings";
  const isDesignSystemSurface = activeView === "design-system";
  const isSecondarySurface = isSettingsSurface || isDesignSystemSurface;
  const mainNavItems: readonly {
    id: AppView;
    label: string;
    icon: SidebarNavItemIcon;
  }[] = [
    { id: "agents", label: t("navigation.agents"), icon: SidebarNavAgentsIcon },
    { id: "skills", label: t("navigation.skills"), icon: SidebarNavSkillsIcon },
    {
      id: "automations",
      label: t("navigation.automations"),
      icon: SidebarNavAutomationsIcon,
    },
    {
      id: "session-history",
      label: t("navigation.sessionHistory"),
      icon: SidebarNavChatsIcon,
    },
  ];
  const showDesignSystemSettingsItem = isDesignSystemExplorerEnabled();

  const projectSessions = useMemo(
    () =>
      getSidebarSessionGroups(visibleSessions, projectIds, sessionStateById),
    [projectIds, sessionStateById, visibleSessions],
  );

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

  // When the active chat changes (e.g. navigating in from elsewhere), bring its
  // row into view if it's scrolled out of sight. Keyed on activeSessionId so it
  // only fires on navigation — manual scrolling within the same chat is left alone.
  useEffect(() => {
    if (!activeSessionId) {
      skipActiveSessionScrollRef.current = null;
      return;
    }

    if (skipActiveSessionScrollRef.current === activeSessionId) {
      skipActiveSessionScrollRef.current = null;
      return;
    }
    skipActiveSessionScrollRef.current = null;

    if (collapsed || isSecondarySurface) return;
    let raf = 0;
    // Navigating into a collapsed project takes a couple of renders to expand
    // and reveal the row, so retry across a few frames until it mounts.
    let attemptsLeft = 3;
    const scrollActiveRowIntoView = () => {
      const nav = navRef.current;
      const row = nav?.querySelector<HTMLElement>(
        `[data-session-id="${CSS.escape(activeSessionId)}"]`,
      );
      if (!nav || !row) {
        if (attemptsLeft-- > 0)
          raf = requestAnimationFrame(scrollActiveRowIntoView);
        return;
      }
      const navRect = nav.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const visibleTop = navRect.top;
      const visibleBottom = navRect.bottom - BOTTOM_MASK_PX;
      if (rowRect.top < visibleTop) {
        nav.scrollTop += rowRect.top - visibleTop;
      } else if (rowRect.bottom > visibleBottom) {
        nav.scrollTop += rowRect.bottom - visibleBottom;
      }
    };
    raf = requestAnimationFrame(scrollActiveRowIntoView);
    return () => cancelAnimationFrame(raf);
  }, [activeSessionId, collapsed, isSecondarySurface]);

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
      <div
        className={cn(
          "h-full rounded-chrome transition-shadow duration-300 ease-out",
          elevatedShadow && SIDEBAR_PANEL_ELEVATED_SHADOW_CLASS,
        )}
      >
        <div className="flex h-full flex-col overflow-hidden rounded-chrome bg-sidebar backdrop-blur-md">
          {/* The goose home affordance now lives in the TopBar (left of the
            panel toggle) so it survives when the panel is collapsed. */}
          <div className="flex-shrink-0 pt-0.5" aria-hidden="true" />

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
                ref={navRef}
                className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 py-1 pb-1 scrollbar-none"
                style={{
                  maskImage: BOTTOM_MASK,
                  WebkitMaskImage: BOTTOM_MASK,
                }}
                aria-label={t("navigation.main")}
              >
                <div className="relative z-10 space-y-0.5">
                  <SidebarNavItem
                    testId="nav-home"
                    icon={SidebarNavHomeIcon}
                    label={t("navigation.home")}
                    collapsed={collapsed}
                    labelTransition={labelTransition}
                    labelVisible={labelVisible}
                    isActive={activeView === "home"}
                    onClick={() => onNavigate?.("home")}
                  />

                  {mainNavItems.map((item) => {
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
                      />
                    );
                  })}

                  <SidebarNavItem
                    testId="nav-settings"
                    icon={SidebarNavSettingsIcon}
                    label={t("settings:title")}
                    collapsed={collapsed}
                    labelTransition={labelTransition}
                    labelVisible={labelVisible}
                    isActive={activeView === "settings"}
                    onClick={() => onSettingsClick?.()}
                  />
                </div>

                {!collapsed && <SidebarPinnedSection />}

                {!collapsed && (
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
                    onSelectSession={selectSessionFromSidebar}
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
                    onPinSelectedToHome={handlePinSelectedToHome}
                    isPinningSelectedToHome={isPinningBatch}
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
                )}
              </nav>
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
                className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 py-1 pb-12 scrollbar-none"
                style={{
                  maskImage: BOTTOM_MASK,
                  WebkitMaskImage: BOTTOM_MASK,
                }}
                aria-label={
                  isSettingsSurface
                    ? t("settings:navigationLabel")
                    : "Design system navigation"
                }
              >
                <div className="space-y-0.5">
                  {isSettingsSurface ? (
                    <>
                      {SETTINGS_SECTIONS.map((item) => (
                        <SidebarNavItem
                          key={item.id}
                          icon={item.icon}
                          label={t(`settings:${item.labelKey}`)}
                          collapsed={collapsed}
                          labelTransition={labelTransition}
                          labelVisible={labelVisible}
                          isActive={activeSettingsSection === item.id}
                          onClick={() => onSettingsSectionChange?.(item.id)}
                        />
                      ))}
                      {showDesignSystemSettingsItem && (
                        <SidebarNavItem
                          icon={IconPalette}
                          label={t("settings:nav.designSystem")}
                          collapsed={collapsed}
                          labelTransition={labelTransition}
                          labelVisible={labelVisible}
                          isActive={false}
                          onClick={() => onNavigate?.("design-system")}
                        />
                      )}
                    </>
                  ) : (
                    <>
                      <SidebarInspectorToggleNavItem
                        checked={designSystemInspectorVisible}
                        collapsed={collapsed}
                        label={t("designSystem.inspector")}
                        labelTransition={labelTransition}
                        labelVisible={labelVisible}
                        onCheckedChange={onDesignSystemInspectorVisibleChange}
                        switchLabel={t("designSystem.showInspector")}
                      />
                      {DESIGN_SYSTEM_CORE_SECTIONS.map((item) => (
                        <SidebarNavItem
                          key={item.id}
                          label={item.label}
                          collapsed={collapsed}
                          labelTransition={labelTransition}
                          labelVisible={labelVisible}
                          isActive={activeDesignSystemSection === item.id}
                          onClick={() => onDesignSystemSectionChange?.(item.id)}
                        />
                      ))}
                      {!collapsed && (
                        <div
                          className={cn(
                            "px-3 pb-1 pt-4 text-sidebar-foreground/25",
                            SIDEBAR_NAV_MICRO_LABEL_TEXT_CLASS,
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
                            "px-3 pb-1 pt-4 text-sidebar-foreground/25",
                            SIDEBAR_NAV_MICRO_LABEL_TEXT_CLASS,
                            labelVisible
                              ? "opacity-100"
                              : "opacity-0 overflow-hidden",
                          )}
                        >
                          {t("sections.notUsed")}
                        </div>
                      )}
                      {DESIGN_SYSTEM_UNUSED_COMPONENT_SECTIONS.map((item) => (
                        <SidebarNavItem
                          key={item.id}
                          label={item.label}
                          collapsed={collapsed}
                          labelTransition={labelTransition}
                          labelVisible={labelVisible}
                          isActive={activeDesignSystemSection === item.id}
                          onClick={() => onDesignSystemSectionChange?.(item.id)}
                        />
                      ))}
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
                    "h-10 w-full rounded-md bg-transparent text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground active:bg-sidebar-accent",
                    SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
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
                        "whitespace-nowrap",
                        SIDEBAR_NAV_TEXT_CLASS,
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
        confirmVariant="default"
        loadingLabel={t("common:bulkActions.archiving")}
        isLoading={isApplyingSelectionAction}
        onConfirm={() => confirmArchiveSelected(onArchiveChat)}
      />
    </div>
  );
}
