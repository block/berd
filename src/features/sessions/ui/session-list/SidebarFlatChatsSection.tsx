import { IconEdit } from "@tabler/icons-react";
import { History } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AppView } from "@/app/AppShell";
import {
  SidebarNavChatPlusIcon,
  SidebarNavChatsIcon,
  SidebarNavProjectPlusIcon,
} from "@/features/navigation/ui/sidebarNavIcons";
import { getDisplaySessionTitle } from "@/features/chat/lib/sessionTitle";
import { ProjectIcon } from "@/features/projects/ui/ProjectIcon";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  SIDEBAR_GROUP_LABEL_TEXT_CLASS,
  SIDEBAR_ROW_HEIGHT_CLASS,
  SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS,
  SIDEBAR_SECTION_ACTION_PILL_CLASS,
  SIDEBAR_SECTION_DIVIDER_INSET_CLASS,
  SIDEBAR_SECTION_DIVIDER_TOP_CLASS,
  SIDEBAR_SECTION_HEADER_ROW_CLASS,
} from "@/shared/ui/sidebar-tokens";
import type { FlatChatGroup } from "@/features/sidebar/lib/sidebarFlatChats";
import { SessionActivityIndicator } from "@/shared/ui/SessionActivityIndicator";
import { SidebarChatDragProvider } from "./SidebarChatDragContext";
import { SidebarChatRow } from "./SidebarChatRow";

export function SidebarFlatChatsSection({
  groups,
  collapsed,
  labelTransition,
  labelVisible,
  activeSessionId,
  onNewChat,
  onCreateProject,
  onNavigate,
  onEditProject,
  onSelectSession,
  onArchiveChat,
  onRenameChat,
  onForkChat,
  onMarkChatRead,
  onMarkChatUnread,
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
  pinnedHomeChatSessionIds,
  showViewAllInHistory = false,
  showTopDivider = true,
}: {
  groups: FlatChatGroup[];
  collapsed: boolean;
  labelTransition: string;
  labelVisible: boolean;
  activeSessionId?: string | null;
  onNewChat?: () => void;
  onCreateProject?: () => void;
  onNavigate?: (view: AppView) => void;
  onEditProject?: (projectId: string) => void;
  onSelectSession?: (sessionId: string) => void;
  onArchiveChat?: (sessionId: string) => void | Promise<void>;
  onRenameChat?: (sessionId: string, nextTitle: string) => void;
  onForkChat?: (sessionId: string) => void;
  onMarkChatRead?: (sessionId: string) => void;
  onMarkChatUnread?: (sessionId: string) => void;
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
  pinnedHomeChatSessionIds: ReadonlySet<string>;
  showViewAllInHistory?: boolean;
  showTopDivider?: boolean;
}) {
  const { t } = useTranslation(["sidebar", "common"]);
  const showEmptyState = groups.length === 0;
  const flatSessions = groups.flatMap((group) => group.sessions);
  const sectionHeaderTextClass = cn(
    SIDEBAR_GROUP_LABEL_TEXT_CLASS,
    "text-muted-foreground",
  );

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
              "border-t border-sidebar-border/80",
            )}
            aria-hidden
          />
        )}
        <div
          className={cn(
            "relative group/chats-header flex items-center",
            collapsed
              ? "px-0 pt-0 pb-1 justify-center"
              : SIDEBAR_SECTION_HEADER_ROW_CLASS,
          )}
        >
          {!collapsed && (
            <span
              className={cn(
                "min-w-0 flex-1 truncate py-1",
                sectionHeaderTextClass,
                labelTransition,
                labelVisible
                  ? "opacity-100 w-auto"
                  : "opacity-0 w-0 overflow-hidden",
              )}
            >
              {t("sections.recents")}
            </span>
          )}
          {!collapsed && (onCreateProject || (onNewChat && !showEmptyState)) ? (
            <div className="ml-1 flex items-center gap-1">
              {onCreateProject ? (
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
                  )}
                >
                  <SidebarNavProjectPlusIcon className="size-4" />
                </Button>
              ) : null}
              {onNewChat && !showEmptyState ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={onNewChat}
                  aria-label={t("actions.newChat")}
                  title={t("actions.newChat")}
                  className={cn(
                    SIDEBAR_SECTION_ACTION_PILL_CLASS,
                    "size-5 bg-transparent p-0 text-muted-foreground hover:bg-sidebar-section-action-bg hover:text-sidebar-foreground focus-visible:bg-sidebar-section-action-bg focus-visible:text-sidebar-foreground",
                  )}
                >
                  <SidebarNavChatPlusIcon className="size-4" />
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        {showEmptyState ? (
          collapsed ? (
            <div className="flex flex-col items-center gap-1">
              {onCreateProject ? (
                <Button
                  type="button"
                  variant="ghost"
                  flush
                  size="icon-xs"
                  onClick={onCreateProject}
                  aria-label={t("actions.newProject")}
                  title={t("actions.newProject")}
                  className="rounded-lg"
                >
                  <SidebarNavProjectPlusIcon className="size-4" />
                </Button>
              ) : null}
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
          ) : (
            <div className="space-y-0.5">
              <Button
                type="button"
                variant="ghost"
                flush
                size="xs"
                onClick={onNewChat}
                className={cn(
                  SIDEBAR_ROW_HEIGHT_CLASS,
                  "w-full justify-start gap-2 text-sm text-muted-foreground",
                  SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS,
                )}
                leftIcon={<IconEdit className="size-4" />}
              >
                {t("empty.startChat")}
              </Button>
            </div>
          )
        ) : collapsed ? (
          <div className="flex flex-col items-center gap-1 pb-2">
            {onCreateProject ? (
              <Button
                type="button"
                variant="ghost"
                flush
                size="icon-xs"
                onClick={onCreateProject}
                aria-label={t("actions.newProject")}
                title={t("actions.newProject")}
                className="rounded-lg"
              >
                <SidebarNavProjectPlusIcon className="size-4" />
              </Button>
            ) : null}
            {onNewChat ? (
              <Button
                type="button"
                variant="ghost"
                flush
                size="icon-xs"
                onClick={onNewChat}
                aria-label={t("actions.newChat")}
                title={t("actions.newChat")}
                className="rounded-lg"
              >
                <IconEdit className="size-4" />
              </Button>
            ) : null}
            {flatSessions.map((session) => {
              const title = getDisplaySessionTitle(
                session.title,
                t("common:session.defaultTitle"),
              );
              const hasProject =
                session.projectId != null && session.projectName != null;
              return (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  key={session.id}
                  title={title}
                  aria-label={title}
                  onClick={() => onSelectSession?.(session.id)}
                  className={cn(
                    "relative rounded-lg",
                    activeSessionId === session.id
                      ? "bg-sidebar-accent text-sidebar-foreground hover:bg-sidebar-accent"
                      : "text-sidebar-foreground hover:text-sidebar-foreground",
                  )}
                >
                  {hasProject ? (
                    <ProjectIcon
                      icon={session.projectIcon}
                      color={session.projectColor}
                      projectId={session.projectId}
                      className="size-[18px]"
                      imageClassName="size-4 rounded-[4px]"
                    />
                  ) : (
                    <SidebarNavChatsIcon className="size-4" />
                  )}
                  {session.isRunning ? (
                    <SessionActivityIndicator isRunning variant="overlay" />
                  ) : session.hasUnread ? (
                    <span className="absolute -right-0.5 -top-0.5">
                      <SessionActivityIndicator hasUnread variant="overlay" />
                    </span>
                  ) : null}
                </Button>
              );
            })}
          </div>
        ) : (
          <div className="pb-2">
            {groups.map((group, groupIndex) => (
              <div
                key={group.id}
                className={cn("space-y-0.5", groupIndex > 0 && "mt-2 pt-2")}
                data-sidebar-flat-chat-group={group.id}
              >
                {group.sessions.map((session) => {
                  const isActive = activeSessionId === session.id;
                  const currentProjectId =
                    session.projectName != null
                      ? (session.projectId ?? null)
                      : null;
                  return (
                    <SidebarChatRow
                      key={session.id}
                      id={session.id}
                      title={session.title}
                      activityAt={session.activityAt}
                      isActive={isActive}
                      isRunning={session.isRunning ?? false}
                      hasUnread={session.hasUnread ?? false}
                      isPinned={pinnedHomeChatSessionIds.has(session.id)}
                      selected={selectedSessionIds?.has(session.id) ?? false}
                      selectionEnabled={selectionEnabled}
                      selectionActionsDisabled={selectionActionsDisabled}
                      selectedSessionIds={selectedSessionIds}
                      density="dense"
                      flatProjectName={
                        session.projectName ?? t("flat.noProject")
                      }
                      flatProjectIcon={session.projectIcon}
                      flatProjectColor={session.projectColor}
                      currentProjectId={currentProjectId}
                      onEditProject={onEditProject}
                      onSelect={onSelectSession}
                      onSelectionClear={onSelectionClear}
                      onSelectionChange={onSelectionChange}
                      onRename={onRenameChat}
                      onFork={onForkChat}
                      onMarkRead={onMarkChatRead}
                      onMarkUnread={onMarkChatUnread}
                      onArchive={onArchiveChat}
                      onArchiveSelected={onArchiveSelected}
                      onPinSelectedToHome={onPinSelectedToHome}
                      isPinningSelectedToHome={isPinningSelectedToHome}
                      onMarkSelectedRead={onMarkSelectedRead}
                      onMarkSelectedUnread={onMarkSelectedUnread}
                    />
                  );
                })}
              </div>
            ))}
            {onNavigate && showViewAllInHistory && (
              <div className={cn(groups.length > 0 && "mt-0.5")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => onNavigate("session-history")}
                  className={cn(
                    "h-auto w-full justify-start gap-2 rounded-sm py-1 text-sm font-normal text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground",
                    SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS,
                    "pl-[14px]",
                  )}
                  leftIcon={<History className="size-3.5" strokeWidth={2} />}
                >
                  {t("viewAllInHistory")}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </SidebarChatDragProvider>
  );
}
