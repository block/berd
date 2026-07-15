import { useTranslation } from "react-i18next";
import { IconChevronDown, IconCubePlus, IconEdit } from "@tabler/icons-react";
import type { AppView } from "@/app/AppShell";
import type { ProjectInfo } from "@/features/projects/api/projects";
import type { FlatChatGroup } from "@/features/sidebar/lib/sidebarFlatChats";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { CollapseReveal } from "@/shared/ui/collapse-reveal";
import {
  SIDEBAR_GROUP_LABEL_TEXT_CLASS,
  SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS,
  SIDEBAR_ROW_HEIGHT_CLASS,
  SIDEBAR_ROW_HOVER_CLASS,
  SIDEBAR_SECTION_HEADER_ROW_CLASS,
} from "@/shared/ui/sidebar-tokens";
import { SidebarChatDragProvider } from "./SidebarChatDragContext";
import {
  SIDEBAR_SECTION_HEADER_ACTION_REVEAL_CLASS,
  SidebarSectionHeader,
  SidebarSectionHeaderAction,
} from "./SidebarSectionHeader";
import { SidebarFlatChatsSection } from "./SidebarFlatChatsSection";
import { SidebarDisplayOptionsMenu } from "./SidebarDisplayOptionsMenu";
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
  onGroupChatsByProjectChange?: (grouped: boolean) => void;
  showChatIcons: boolean;
  onShowChatIconsChange: (show: boolean) => void;
  showTimestamps: boolean;
  onShowTimestampsChange: (show: boolean) => void;
  showGitBranches: boolean;
  onShowGitBranchesChange: (show: boolean) => void;
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

/** Typography only — color comes from the ghost+flush toggle Button so the
 * label and chevron always match at rest and on hover. */
const SECTION_HEADER_TEXT_CLASS = SIDEBAR_GROUP_LABEL_TEXT_CLASS;

export function SidebarProjectsSection({
  projects,
  projectSessions,
  hasVisibleChats,
  flatChatGroups,
  hasFlatChatOverflow,
  groupChatsByProject,
  onGroupChatsByProjectChange,
  showChatIcons,
  onShowChatIconsChange,
  showTimestamps,
  onShowTimestampsChange,
  showGitBranches,
  onShowGitBranchesChange,
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
  showTopDivider: _showTopDivider = true,
}: SidebarProjectsSectionProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const showProjectsEmptyState = projects.length === 0;
  const showChatsEmptyState = projectSessions.standalone.length === 0;
  const showCombinedEmptyState = showProjectsEmptyState && !hasVisibleChats;
  const showProjects = collapsed || projectsSectionOpen;
  const emptyActionClasses = cn(
    SIDEBAR_ROW_HEIGHT_CLASS,
    SIDEBAR_ROW_HOVER_CLASS,
    "w-full justify-start gap-2 text-sm text-muted-foreground",
    SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS,
  );

  if (!groupChatsByProject) {
    return (
      <SidebarFlatChatsSection
        groups={flatChatGroups}
        onGroupChatsByProjectChange={onGroupChatsByProjectChange}
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
        showTimestamps={showTimestamps}
        onShowTimestampsChange={onShowTimestampsChange}
        showGitBranches={showGitBranches}
        onShowGitBranchesChange={onShowGitBranchesChange}
        showViewAllInHistory={hasFlatChatOverflow}
        showTopDivider={_showTopDivider}
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
        <SidebarSectionHeader
          label={t("sections.projects")}
          collapsed={collapsed}
          labelTransition={labelTransition}
          labelVisible={labelVisible}
          onToggleOpen={onToggleProjectsSection}
          isOpen={projectsSectionOpen}
          showChevron={!showProjectsEmptyState}
          labelClassName={SECTION_HEADER_TEXT_CLASS}
          actions={
            !showProjectsEmptyState ? (
              <>
                <SidebarDisplayOptionsMenu
                  labelKey="actions.projectDisplayOptions"
                  showChatIcons={showChatIcons}
                  onShowChatIconsChange={onShowChatIconsChange}
                  showTimestamps={showTimestamps}
                  onShowTimestampsChange={onShowTimestampsChange}
                  showGitBranches={showGitBranches}
                  onShowGitBranchesChange={onShowGitBranchesChange}
                  groupChatsByProject
                  onGroupChatsByProjectChange={onGroupChatsByProjectChange}
                  className={SIDEBAR_SECTION_HEADER_ACTION_REVEAL_CLASS}
                />
                <SidebarSectionHeaderAction
                  icon={IconCubePlus}
                  label={t("actions.newProject")}
                  onClick={onCreateProject}
                />
              </>
            ) : null
          }
        />

        <CollapseReveal open={showProjects}>
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
            showChatIcons={showChatIcons}
            showTimestamps={showTimestamps}
            onReorderProject={onReorderProject}
            hasMoreSessions={hasMoreSessions}
            dropTargetsEnabled={showProjects}
          />
        </CollapseReveal>

        {showProjectsEmptyState &&
          (collapsed ? (
            <div className="flex flex-col items-center gap-0">
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
                <IconCubePlus className="size-4" />
              </Button>
            </div>
          ) : (
            <div className="space-y-0">
              <Button
                type="button"
                variant="ghost"
                flush
                size="xs"
                onClick={onCreateProject}
                className={emptyActionClasses}
                leftIcon={<IconCubePlus className="size-3.5" />}
              >
                {t("empty.createProject")}
              </Button>
            </div>
          ))}

        {showCombinedEmptyState && collapsed ? (
          <div className="flex flex-col items-center gap-0">
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
                  : SIDEBAR_SECTION_HEADER_ROW_CLASS,
              )}
            >
              {!collapsed && (
                <Button
                  type="button"
                  variant="ghost"
                  flush
                  size="xs"
                  onClick={onToggleRecentsSection}
                  aria-expanded={recentsSectionOpen}
                  className={cn(
                    "h-7 min-w-0 flex-1 justify-start gap-1.5",
                    labelTransition,
                    labelVisible
                      ? "opacity-100 w-auto"
                      : "opacity-0 w-0 overflow-hidden",
                  )}
                >
                  <IconChevronDown
                    className={cn(
                      "size-3 shrink-0 transition-transform duration-150",
                      !recentsSectionOpen && "-rotate-90",
                    )}
                  />
                  <span className={cn("truncate", SECTION_HEADER_TEXT_CLASS)}>
                    {t("sections.recents")}
                  </span>
                </Button>
              )}
            </div>
            <div className="space-y-0">
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
            showChatIcons={showChatIcons}
            onShowChatIconsChange={onShowChatIconsChange}
            showTimestamps={showTimestamps}
            onShowTimestampsChange={onShowTimestampsChange}
            showGitBranches={showGitBranches}
            onShowGitBranchesChange={onShowGitBranchesChange}
            isOpen={recentsSectionOpen}
            onToggleOpen={onToggleRecentsSection}
            sectionHeaderTextClass={SECTION_HEADER_TEXT_CLASS}
          />
        )}
      </div>
    </SidebarChatDragProvider>
  );
}
