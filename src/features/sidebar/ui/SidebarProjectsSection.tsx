import { useTranslation } from "react-i18next";
import { IconEdit, IconFolderPlus } from "@tabler/icons-react";
import type { AppView } from "@/app/AppShell";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { SidebarProjectList } from "./SidebarProjectList";
import type { SidebarSessionItem } from "./SidebarProjectSection";
import { SidebarRecentsSection } from "./SidebarRecentsSection";

interface SidebarProjectsSectionProps {
  projects: ProjectInfo[];
  projectSessions: {
    byProject: Record<string, SidebarSessionItem[]>;
    standalone: SidebarSessionItem[];
  };
  hasVisibleChats: boolean;
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
  onMarkChatRead?: (sessionId: string) => void;
  onMarkChatUnread?: (sessionId: string) => void;
  onMoveToProject?: (sessionId: string, projectId: string | null) => void;
  selectedSessionIds?: Set<string>;
  selectionEnabled?: boolean;
  selectionActionsDisabled?: boolean;
  onSelectionClear?: () => void;
  onSelectionChange?: (sessionId: string, selected: boolean) => void;
  onArchiveSelected?: () => void;
  onMarkSelectedRead?: () => void;
  onMarkSelectedUnread?: () => void;
  onReorderProject?: (fromId: string, toId: string) => void;
  hasMoreSessions?: boolean;
}

const SECTION_HEADER_TEXT_CLASS = "text-[13px] font-normal text-foreground";

export function SidebarProjectsSection({
  projects,
  projectSessions,
  hasVisibleChats,
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
  onMarkChatRead,
  onMarkChatUnread,
  onMoveToProject,
  selectedSessionIds,
  selectionEnabled = false,
  selectionActionsDisabled = false,
  onSelectionClear,
  onSelectionChange,
  onArchiveSelected,
  onMarkSelectedRead,
  onMarkSelectedUnread,
  onReorderProject,
  hasMoreSessions = false,
}: SidebarProjectsSectionProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const showProjectsEmptyState = projects.length === 0;
  const showChatsEmptyState = projectSessions.standalone.length === 0;
  const showCombinedEmptyState = showProjectsEmptyState && !hasVisibleChats;
  const emptyActionClasses =
    "h-8 w-full justify-start px-3 text-[13px] text-muted-foreground";

  return (
    <div
      className={cn(
        "relative z-10 mt-4 before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-border-soft",
        labelTransition,
        labelVisible
          ? "opacity-100 max-h-[2000px]"
          : collapsed
            ? "opacity-100 max-h-[2000px]"
            : "opacity-0 max-h-0 overflow-hidden",
      )}
    >
      <div
        className={cn(
          "group/projects-header flex items-center transition-all duration-300",
          collapsed ? "px-0 pt-0 pb-1 justify-center" : "px-3 pt-3 pb-1.5",
        )}
      >
        {!collapsed && (
          <div
            className={cn(
              "flex min-w-0 flex-1 items-center py-1 text-left",
              labelTransition,
              labelVisible
                ? "opacity-100 w-auto"
                : "opacity-0 w-0 overflow-hidden",
            )}
          >
            <span className={cn("truncate", SECTION_HEADER_TEXT_CLASS)}>
              {t("sections.projects")}
            </span>
          </div>
        )}
        {!collapsed && !showProjectsEmptyState && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onCreateProject}
            title={t("actions.newProject")}
            className={cn(
              "mr-1 h-6 flex-shrink-0 rounded-full bg-surface-tile px-2 text-[11px] text-foreground opacity-0 transition-opacity duration-150 ease-out hover:bg-surface-tile hover:text-foreground",
              "pointer-events-none group-hover/projects-header:pointer-events-auto group-hover/projects-header:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100",
            )}
          >
            {t("actions.newProject")}
          </Button>
        )}
      </div>

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
        onMarkChatRead={onMarkChatRead}
        onMarkChatUnread={onMarkChatUnread}
        onMoveToProject={onMoveToProject}
        selectedSessionIds={selectedSessionIds}
        selectionEnabled={selectionEnabled}
        selectionActionsDisabled={selectionActionsDisabled}
        onSelectionClear={onSelectionClear}
        onSelectionChange={onSelectionChange}
        onArchiveSelected={onArchiveSelected}
        onMarkSelectedRead={onMarkSelectedRead}
        onMarkSelectedUnread={onMarkSelectedUnread}
        onReorderProject={onReorderProject}
        hasMoreSessions={hasMoreSessions}
      />

      {showProjectsEmptyState &&
        (collapsed ? (
          <div className="flex flex-col items-center gap-1">
            <Button
              type="button"
              variant="quiet"
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
              variant="quiet"
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
            variant="quiet"
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
              collapsed ? "px-0 pt-0 pb-1 justify-center" : "pt-5 pb-1.5",
            )}
          >
            {!collapsed && (
              <div
                className={cn(
                  "flex min-w-0 flex-1 items-center py-1 text-left",
                  labelTransition,
                  labelVisible
                    ? "opacity-100 w-auto"
                    : "opacity-0 w-0 overflow-hidden",
                )}
              >
                <span className={cn("truncate", SECTION_HEADER_TEXT_CLASS)}>
                  {t("sections.recents")}
                </span>
              </div>
            )}
          </div>
          <div className="space-y-0.5">
            <Button
              type="button"
              variant="quiet"
              size="xs"
              onClick={onNewChat}
              className={emptyActionClasses}
              leftIcon={<IconEdit className="size-3.5" />}
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
          onSelectSession={onSelectSession}
          onArchiveChat={onArchiveChat}
          onRenameChat={onRenameChat}
          onMarkChatRead={onMarkChatRead}
          onMarkChatUnread={onMarkChatUnread}
          onMoveToProject={onMoveToProject}
          selectedSessionIds={selectedSessionIds}
          selectionEnabled={selectionEnabled}
          selectionActionsDisabled={selectionActionsDisabled}
          onSelectionClear={onSelectionClear}
          onSelectionChange={onSelectionChange}
          onArchiveSelected={onArchiveSelected}
          onMarkSelectedRead={onMarkSelectedRead}
          onMarkSelectedUnread={onMarkSelectedUnread}
          sectionHeaderTextClass={SECTION_HEADER_TEXT_CLASS}
        />
      )}
    </div>
  );
}
