import { IconCubePlus, IconEdit, IconPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { AppView } from "@/app/AppShell";
import { SidebarNavChatsIcon } from "@/features/navigation/ui/sidebarNavIcons";
import { getDisplaySessionTitle } from "@/features/chat/lib/sessionTitle";
import { ProjectIcon } from "@/features/projects/ui/ProjectIcon";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { SidebarDisclosureButton } from "@/shared/ui/sidebar-disclosure-button";
import {
  SIDEBAR_GROUP_LABEL_TEXT_CLASS,
  SIDEBAR_ROW_HEIGHT_CLASS,
  SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS,
  SIDEBAR_ROW_HOVER_CLASS,
} from "@/shared/ui/sidebar-tokens";
import type { FlatChatGroup } from "@/features/sidebar/lib/sidebarFlatChats";
import { SessionActivityIndicator } from "@/shared/ui/SessionActivityIndicator";
import { SidebarChatDragProvider } from "./SidebarChatDragContext";
import { SidebarDisplayOptionsMenu } from "./SidebarDisplayOptionsMenu";
import {
  SIDEBAR_SECTION_HEADER_ACTION_REVEAL_CLASS,
  SidebarSectionHeader,
  SidebarSectionHeaderAction,
} from "./SidebarSectionHeader";
import { SidebarChatRow } from "./SidebarChatRow";

export function SidebarFlatChatsSection({
  groups,
  onGroupChatsByProjectChange,
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
  showChatIcons = false,
  showTimestamps,
  onShowTimestampsChange,
  showViewAllInHistory = false,
  compactGroups = false,
  compactHeader = false,
  showTopDivider: _showTopDivider = true,
}: {
  groups: FlatChatGroup[];
  onGroupChatsByProjectChange?: (grouped: boolean) => void;
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
  showChatIcons?: boolean;
  showTimestamps: boolean;
  onShowTimestampsChange: (show: boolean) => void;
  showViewAllInHistory?: boolean;
  compactGroups?: boolean;
  compactHeader?: boolean;
  showTopDivider?: boolean;
}) {
  const { t } = useTranslation(["sidebar", "common"]);
  const showEmptyState = groups.length === 0;
  const flatSessions = groups.flatMap((group) => group.sessions);
  /** Typography only — color comes from the ghost+flush toggle Button so the
   * label and chevron always match at rest and on hover. */
  const sectionHeaderTextClass = SIDEBAR_GROUP_LABEL_TEXT_CLASS;

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
          label={t("sections.recents")}
          collapsed={collapsed}
          labelTransition={labelTransition}
          labelVisible={labelVisible}
          labelClassName={sectionHeaderTextClass}
          className={compactHeader ? "pt-0" : undefined}
          actions={
            (onNavigate && showViewAllInHistory) ||
            onCreateProject ||
            (onNewChat && !showEmptyState) ? (
              <>
                <SidebarDisplayOptionsMenu
                  labelKey="actions.chatDisplayOptions"
                  showTimestamps={showTimestamps}
                  onShowTimestampsChange={onShowTimestampsChange}
                  groupChatsByProject={false}
                  onGroupChatsByProjectChange={onGroupChatsByProjectChange}
                  className={SIDEBAR_SECTION_HEADER_ACTION_REVEAL_CLASS}
                />
                {onCreateProject ? (
                  <SidebarSectionHeaderAction
                    icon={IconPlus}
                    label={t("actions.newProject")}
                    onClick={onCreateProject}
                  />
                ) : null}
                {onNewChat && !showEmptyState ? (
                  <SidebarSectionHeaderAction
                    icon={IconEdit}
                    label={t("actions.newChat")}
                    onClick={onNewChat}
                  />
                ) : null}
              </>
            ) : null
          }
        />

        {showEmptyState ? (
          collapsed ? (
            <div className="flex flex-col items-center gap-0">
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
                  <IconCubePlus className="size-4" />
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
            <div className="space-y-0">
              <Button
                type="button"
                variant="ghost"
                flush
                size="xs"
                onClick={onNewChat}
                className={cn(
                  SIDEBAR_ROW_HEIGHT_CLASS,
                  SIDEBAR_ROW_HOVER_CLASS,
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
          <div className="flex flex-col items-center gap-0 pb-1">
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
                <IconCubePlus className="size-4" />
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
                      ? "bg-[var(--sidebar-row-active)] text-sidebar-foreground hover:bg-[var(--sidebar-row-active)]"
                      : "text-sidebar-foreground hover:bg-[var(--sidebar-row-hover)] hover:text-sidebar-foreground",
                  )}
                >
                  {hasProject ? (
                    <ProjectIcon
                      icon={session.projectIcon}
                      color={session.projectColor}
                      projectId={session.projectId ?? undefined}
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
          <div className="pb-1">
            {groups.map((group, groupIndex) => (
              <div
                key={group.id}
                className={cn(
                  "space-y-0",
                  !compactGroups && groupIndex > 0 && "mt-1 pt-1",
                )}
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
                      branchName={session.branchName}
                      activityAt={session.activityAt}
                      showLeadingIcon={showChatIcons}
                      showTimestamp={showTimestamps}
                      showRenameTooltip={false}
                      isActive={isActive}
                      isRunning={session.isRunning ?? false}
                      hasUnread={session.hasUnread ?? false}
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
            {showViewAllInHistory && onNavigate ? (
              <SidebarDisclosureButton
                type="button"
                row
                onClick={() => onNavigate("session-history")}
                className={cn(
                  "h-7 w-full justify-start rounded-sm px-3 py-1 text-sm",
                  SIDEBAR_GROUP_LABEL_TEXT_CLASS,
                )}
              >
                {t("viewAllInHistory")}
              </SidebarDisclosureButton>
            ) : null}
          </div>
        )}
      </div>
    </SidebarChatDragProvider>
  );
}
