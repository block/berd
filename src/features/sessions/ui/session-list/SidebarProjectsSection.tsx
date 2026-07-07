import { useTranslation } from "react-i18next";
import {
  IconChevronDown,
  IconEdit,
  IconFolderPlus,
  IconPlus,
} from "@tabler/icons-react";
import type { AppView } from "@/app/AppShell";
import type { ProjectInfo } from "@/features/projects/api/projects";
import type { FlatChatGroup } from "@/features/sidebar/lib/sidebarFlatChats";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  SIDEBAR_GROUP_LABEL_TEXT_CLASS,
  SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS,
  SIDEBAR_ROW_HEIGHT_CLASS,
  SIDEBAR_SECTION_DIVIDER_INSET_CLASS,
  SIDEBAR_SECTION_DIVIDER_TOP_CLASS,
  SIDEBAR_SECTION_ACTION_PILL_CLASS,
  SIDEBAR_SECTION_HEADER_ROW_CLASS,
} from "@/shared/ui/sidebar-tokens";
import { SidebarChatDragProvider } from "./SidebarChatDragContext";
import { SidebarFlatChatsSection } from "./SidebarFlatChatsSection";
import { SidebarProjectList } from "./SidebarProjectList";
import type { SidebarSessionItem } from "./SidebarProjectSection";
import { SidebarRecentsSection } from "./SidebarRecentsSection";

export interface SidebarProjectsSectionProps {
  projects: ProjectInfo[];
  projectSessions: {
    byProject: Record<string, SidebarSessionItem[]>;
    standalone: SidebarSessionItem[];
  };
  hasVisibleChats: boolean;
  flatChatGroups: FlatChatGroup[];
  hasFlatChatOverflow: boolean;
  groupChatsByProject: boolean;
  pinnedHomeChatSessionIds: ReadonlySet<string>;
  expandedProjects: Record<string, boolean>;
  toggleProject: (projectId: string) => void;
  collapsed: boolean;
  labelTransition: string;
  labelVisible: boolean;
  activeSessionId?: string | null;
  onNavigate?: (view: AppView) => void;
  onSelectSession?: (sessionId: string) => void;
  onNewChatInProject?: (projectId: string) => void;
  onNewChat?: () => void;
  onCreateProject?: () => void;
  onEditProject?: (projectId: string) => void;
  onArchiveProject?: (projectId: string) => void;
  onArchiveChat?: (sessionId: string) => void | Promise<void>;
  onRenameChat?: (sessionId: string, nextTitle: string) => void;
  onForkChat?: (sessionId: string) => void;
  onMarkChatRead?: (sessionId: string) => void;
  onMarkChatUnread?: (sessionId: string) => void;
  onMoveToProject?: (sessionId: string, projectId: string | null) => void;
  selectedSessionIds?: Set<string>;
  selectionEnabled?: boolean;
  selectionActionsDisabled?: boolean;
  onSelectionClear?: () => void;
  onSelectionChange?: (sessionId: string, selected: boolean) => void;
  onArchiveSelected?: () => void;
  onPinSelectedToHome?: () => void;
  isPinningSelectedToHome?: boolean;
  onMarkSelectedRead?: () => void;
  onMarkSelectedUnread?: () => void;
  onReorderProject?: (
    fromId: string,
    toId: string,
    placement?: "before" | "after",
  ) => void;
  hasMoreSessions?: boolean;
  projectsSectionOpen: boolean;
  recentsSectionOpen: boolean;
  onToggleProjectsSection: () => void;
  onToggleRecentsSection: () => void;
  showTopDivider?: boolean;
}

const SECTION_HEADER_TEXT_CLASS = cn(
  SIDEBAR_GROUP_LABEL_TEXT_CLASS,
  "text-muted-foreground",
);

export function SidebarProjectsSection({
  projects,
  projectSessions,
  hasVisibleChats,
  flatChatGroups,
  hasFlatChatOverflow,
  groupChatsByProject,
  pinnedHomeChatSessionIds,
  expandedProjects,
  toggleProject,
  collapsed,
  labelTransition,
  labelVisible,
  activeSessionId,
  onNavigate,
  onSelectSession,
  onNewChatInProject,
  onNewChat,
  onCreateProject,
  onEditProject,
  onArchiveProject,
  onArchiveChat,
  onRenameChat,
  onForkChat,
  onMarkChatRead,
  onMarkChatUnread,
  onMoveToProject,
  selectedSessionIds,
  selectionEnabled = false,
  selectionActionsDisabled = false,
  onSelectionClear,
  onSelectionChange,
  onArchiveSelected,
  onPinSelectedToHome,
  isPinningSelectedToHome = false,
  onMarkSelectedRead,
  onMarkSelectedUnread,
  onReorderProject,
  hasMoreSessions = false,
  projectsSectionOpen,
  recentsSectionOpen,
  onToggleProjectsSection,
  onToggleRecentsSection,
  showTopDivider = true,
}: SidebarProjectsSectionProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const showProjectsEmptyState = projects.length === 0;
  const showChatsEmptyState = projectSessions.standalone.length === 0;
  const showCombinedEmptyState = showProjectsEmptyState && !hasVisibleChats;
  const showProjects = collapsed || projectsSectionOpen;
  const emptyActionClasses = `${SIDEBAR_ROW_HEIGHT_CLASS} w-full justify-start gap-2 ${SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS} text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground`;

  if (!groupChatsByProject) {
    return (
      <SidebarFlatChatsSection
        groups={flatChatGroups}
        collapsed={collapsed}
        labelTransition={labelTransition}
        labelVisible={labelVisible}
        activeSessionId={activeSessionId}
        onNewChat={onNewChat}
        onCreateProject={onCreateProject}
        onNavigate={onNavigate}
        onEditProject={onEditProject}
        onSelectSession={onSelectSession}
        onArchiveChat={onArchiveChat}
        onRenameChat={onRenameChat}
        onForkChat={onForkChat}
        onMarkChatRead={onMarkChatRead}
        onMarkChatUnread={onMarkChatUnread}
        selectedSessionIds={selectedSessionIds}
        selectionEnabled={selectionEnabled}
        selectionActionsDisabled={selectionActionsDisabled}
        onSelectionClear={onSelectionClear}
        onSelectionChange={onSelectionChange}
        onArchiveSelected={onArchiveSelected}
        onPinSelectedToHome={onPinSelectedToHome}
        isPinningSelectedToHome={isPinningSelectedToHome}
        onMarkSelectedRead={onMarkSelectedRead}
        onMarkSelectedUnread={onMarkSelectedUnread}
        pinnedHomeChatSessionIds={pinnedHomeChatSessionIds}
        showViewAllInHistory={hasFlatChatOverflow}
        showTopDivider={showTopDivider}
      />
    );
  }

  return (
    <SidebarChatDragProvider>
      <div
        className={cn(
          "relative z-10",
          labelTransition,
          labelVisible
            ? "opacity-100 max-h-[2000px]"
            : collapsed
              ? "opacity-100 max-h-[2000px]"
              : "opacity-0 max-h-0 overflow-hidden",
        )}
      >
        {showTopDivider && (
          <div
            className={cn(
              SIDEBAR_SECTION_DIVIDER_INSET_CLASS,
              SIDEBAR_SECTION_DIVIDER_TOP_CLASS,
              "border-t border-border/80",
            )}
            aria-hidden
          />
        )}
        <div
          className={cn(
            "group/projects-header flex items-center",
            collapsed
              ? "px-0 pt-0 pb-1 justify-center"
              : SIDEBAR_SECTION_HEADER_ROW_CLASS,
          )}
        >
          {!collapsed && (
            <button
              type="button"
              onClick={onToggleProjectsSection}
              aria-expanded={projectsSectionOpen}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-0.5 rounded-sm py-1 text-left transition-colors hover:text-foreground",
                labelTransition,
                labelVisible
                  ? "opacity-100 w-auto"
                  : "opacity-0 w-0 overflow-hidden",
              )}
            >
              <span className={cn("truncate", SECTION_HEADER_TEXT_CLASS)}>
                {t("sections.projects")}
              </span>
              {!showProjectsEmptyState && (
                <IconChevronDown
                  className={cn(
                    "invisible size-3 shrink-0 text-muted-foreground transition-transform duration-150",
                    "group-hover/projects-header:visible",
                    !projectsSectionOpen && "-rotate-90",
                  )}
                />
              )}
            </button>
          )}
          {!collapsed && !showProjectsEmptyState && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={onCreateProject}
              aria-label={t("actions.newProject")}
              title={t("actions.newProject")}
              className={cn(
                SIDEBAR_SECTION_ACTION_PILL_CLASS,
                "size-5 bg-transparent p-0 text-muted-foreground hover:bg-sidebar-section-action-bg hover:text-sidebar-foreground focus-visible:bg-sidebar-section-action-bg focus-visible:text-sidebar-foreground",
                "invisible pointer-events-none group-hover/projects-header:visible group-hover/projects-header:pointer-events-auto group-focus-within/projects-header:visible group-focus-within/projects-header:pointer-events-auto focus-visible:visible focus-visible:pointer-events-auto",
              )}
            >
              <IconPlus className="size-4" />
            </Button>
          )}
        </div>

        {showProjects && (
          <SidebarProjectList
            projects={projects}
            projectSessionsByProject={projectSessions.byProject}
            expandedProjects={expandedProjects}
            toggleProject={toggleProject}
            collapsed={collapsed}
            activeSessionId={activeSessionId}
            onNavigate={onNavigate}
            onSelectSession={onSelectSession}
            onNewChatInProject={onNewChatInProject}
            onEditProject={onEditProject}
            onArchiveProject={onArchiveProject}
            onArchiveChat={onArchiveChat}
            onRenameChat={onRenameChat}
            onForkChat={onForkChat}
            onMarkChatRead={onMarkChatRead}
            onMarkChatUnread={onMarkChatUnread}
            onMoveToProject={onMoveToProject}
            selectedSessionIds={selectedSessionIds}
            selectionEnabled={selectionEnabled}
            selectionActionsDisabled={selectionActionsDisabled}
            onSelectionClear={onSelectionClear}
            onSelectionChange={onSelectionChange}
            onArchiveSelected={onArchiveSelected}
            onPinSelectedToHome={onPinSelectedToHome}
            isPinningSelectedToHome={isPinningSelectedToHome}
            onMarkSelectedRead={onMarkSelectedRead}
            onMarkSelectedUnread={onMarkSelectedUnread}
            pinnedHomeChatSessionIds={pinnedHomeChatSessionIds}
            onReorderProject={onReorderProject}
            hasMoreSessions={hasMoreSessions}
          />
        )}

        {showProjectsEmptyState &&
          (collapsed ? (
            <div className="flex flex-col items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                flush
                size="icon-xs"
                onClick={onCreateProject}
                aria-label={t("empty.createProject")}
                title={t("empty.createProject")}
                className="rounded-lg"
              >
                <IconFolderPlus className="size-4" />
              </Button>
            </div>
          ) : (
            <div className="space-y-0.5">
              <Button
                type="button"
                variant="ghost"
                flush
                size="xs"
                onClick={onCreateProject}
                className={emptyActionClasses}
                leftIcon={<IconFolderPlus className="size-3.5" />}
              >
                {t("empty.createProject")}
              </Button>
            </div>
          ))}

        {showCombinedEmptyState && collapsed ? (
          <div className="flex flex-col items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              flush
              size="icon-xs"
              onClick={onNewChat}
              aria-label={t("empty.startChat")}
              title={t("empty.startChat")}
              className="rounded-lg"
            >
              <IconEdit className="size-4" />
            </Button>
          </div>
        ) : showCombinedEmptyState ? (
          <>
            <div
              className={cn(
                "relative flex items-center transition-all duration-300",
                collapsed
                  ? "px-0 pt-0 pb-1 justify-center"
                  : "px-3 pt-3 pb-1.5",
              )}
            >
              {!collapsed && (
                <button
                  type="button"
                  onClick={onToggleRecentsSection}
                  aria-expanded={recentsSectionOpen}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-1 pl-3 text-left transition-colors hover:text-foreground",
                    "-ml-3",
                    labelTransition,
                    labelVisible
                      ? "opacity-100 w-auto"
                      : "opacity-0 w-0 overflow-hidden",
                  )}
                >
                  <IconChevronDown
                    className={cn(
                      "size-3 shrink-0 text-muted-foreground transition-transform duration-150",
                      !recentsSectionOpen && "-rotate-90",
                    )}
                  />
                  <span className={cn("truncate", SECTION_HEADER_TEXT_CLASS)}>
                    {t("sections.recents")}
                  </span>
                </button>
              )}
            </div>
            <div className="space-y-0.5">
              <Button
                type="button"
                variant="ghost"
                flush
                size="xs"
                onClick={onNewChat}
                className={emptyActionClasses}
                leftIcon={<IconEdit className="size-4" />}
              >
                {t("empty.startChat")}
              </Button>
            </div>
          </>
        ) : (
          <SidebarRecentsSection
            sessions={projectSessions.standalone}
            collapsed={collapsed}
            labelTransition={labelTransition}
            labelVisible={labelVisible}
            showEmptyState={showChatsEmptyState}
            activeSessionId={activeSessionId}
            onNewChat={onNewChat}
            onNavigate={onNavigate}
            onSelectSession={onSelectSession}
            onArchiveChat={onArchiveChat}
            onRenameChat={onRenameChat}
            onForkChat={onForkChat}
            onMarkChatRead={onMarkChatRead}
            onMarkChatUnread={onMarkChatUnread}
            onMoveToProject={onMoveToProject}
            selectedSessionIds={selectedSessionIds}
            selectionEnabled={selectionEnabled}
            selectionActionsDisabled={selectionActionsDisabled}
            onSelectionClear={onSelectionClear}
            onSelectionChange={onSelectionChange}
            onArchiveSelected={onArchiveSelected}
            onPinSelectedToHome={onPinSelectedToHome}
            isPinningSelectedToHome={isPinningSelectedToHome}
            onMarkSelectedRead={onMarkSelectedRead}
            onMarkSelectedUnread={onMarkSelectedUnread}
            pinnedHomeChatSessionIds={pinnedHomeChatSessionIds}
            isOpen={recentsSectionOpen}
            onToggleOpen={onToggleRecentsSection}
            sectionHeaderTextClass={SECTION_HEADER_TEXT_CLASS}
          />
        )}
      </div>
    </SidebarChatDragProvider>
  );
}
