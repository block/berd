import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { IconEdit } from "@tabler/icons-react";
import type { AppView } from "@/app/AppShell";
import { getDisplaySessionTitle } from "@/features/chat/lib/sessionTitle";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { CollapseReveal } from "@/shared/ui/collapse-reveal";
import {
  SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS,
  SIDEBAR_ROW_HEIGHT_CLASS,
  SIDEBAR_ROW_HOVER_CLASS,
} from "@/shared/ui/sidebar-tokens";
import { SessionActivityIndicator } from "@/shared/ui/SessionActivityIndicator";
import { SidebarDisplayOptionsMenu } from "./SidebarDisplayOptionsMenu";
import {
  SIDEBAR_SECTION_HEADER_ACTION_REVEAL_CLASS,
  SidebarSectionHeader,
  SidebarSectionHeaderAction,
} from "./SidebarSectionHeader";
import { SidebarChatMenuIcon } from "./SidebarChatMenuIcon";
import { SidebarChatRow } from "./SidebarChatRow";
import { useSidebarChatDrag } from "./SidebarChatDragContext";
import type { SidebarSessionItem } from "./SidebarProjectSection";

export function SidebarRecentsSection({
  sessions,
  collapsed,
  labelTransition,
  labelVisible,
  showEmptyState = false,
  activeSessionId,
  onNewChat,
  onNavigate,
  onSelectSession,
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
  onRangeSelect,
  onArchiveSelected,
  onPinSelectedToHome,
  onUnpinSelectedFromHome,
  isSelectionPinnedToHome,
  onOpenSelectedInWindows,
  isPinningSelectedToHome = false,
  onMarkSelectedRead,
  onMarkSelectedUnread,
  showChatIcons,
  onShowChatIconsChange,
  showTimestamps,
  onShowTimestampsChange,
  isOpen,
  onToggleOpen,
  sectionHeaderTextClass,
  showHeader = true,
}: {
  sessions: SidebarSessionItem[];
  collapsed: boolean;
  labelTransition: string;
  labelVisible: boolean;
  showEmptyState?: boolean;
  activeSessionId?: string | null;
  onNewChat?: () => void;
  onNavigate?: (view: AppView) => void;
  onSelectSession?: (sessionId: string) => void;
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
  onRangeSelect?: (sessionId: string) => void;
  onArchiveSelected?: () => void;
  onPinSelectedToHome?: () => void;
  onUnpinSelectedFromHome?: () => void;
  isSelectionPinnedToHome?: boolean;
  onOpenSelectedInWindows?: () => void;
  isPinningSelectedToHome?: boolean;
  onMarkSelectedRead?: () => void;
  onMarkSelectedUnread?: () => void;
  showChatIcons: boolean;
  onShowChatIconsChange: (show: boolean) => void;
  showTimestamps: boolean;
  onShowTimestampsChange: (show: boolean) => void;
  isOpen: boolean;
  onToggleOpen: () => void;
  sectionHeaderTextClass: string;
  showHeader?: boolean;
}) {
  const { t } = useTranslation(["sidebar", "common"]);
  const { activeSessionDropTargetKey, registerSessionDropTarget } =
    useSidebarChatDrag();
  const recentsDropTargetRef = useRef<HTMLDivElement>(null);
  const showContent = collapsed || showEmptyState || isOpen;
  const recentsDropTargetKey = "recents";

  const handleSessionDrop = useCallback(
    (sessionId: string) => {
      onMoveToProject?.(sessionId, null);
    },
    [onMoveToProject],
  );

  useEffect(() => {
    const element = recentsDropTargetRef.current;
    if (!element) return;
    return registerSessionDropTarget({
      key: recentsDropTargetKey,
      kind: "recents",
      projectId: null,
      element,
      onDrop: handleSessionDrop,
    });
  }, [handleSessionDrop, registerSessionDropTarget]);

  const recentsDragOver = activeSessionDropTargetKey === recentsDropTargetKey;

  return (
    <div ref={recentsDropTargetRef} data-sidebar-session-drop-target="recents">
      {showHeader ? (
        <SidebarSectionHeader
          label={t("sections.recents")}
          collapsed={collapsed}
          labelTransition={labelTransition}
          labelVisible={labelVisible}
          onToggleOpen={showEmptyState ? undefined : onToggleOpen}
          isOpen={isOpen}
          labelClassName={sectionHeaderTextClass}
          actions={
            onNavigate || (onNewChat && !showEmptyState) ? (
              <>
                <SidebarDisplayOptionsMenu
                  labelKey="actions.chatDisplayOptions"
                  showChatIcons={showChatIcons}
                  onShowChatIconsChange={onShowChatIconsChange}
                  showTimestamps={showTimestamps}
                  onShowTimestampsChange={onShowTimestampsChange}
                  className={SIDEBAR_SECTION_HEADER_ACTION_REVEAL_CLASS}
                />
                {onNewChat && !showEmptyState ? (
                  <SidebarSectionHeaderAction
                    icon={IconEdit}
                    label={t("empty.startChat")}
                    onClick={onNewChat}
                  />
                ) : null}
              </>
            ) : null
          }
        >
          {recentsDragOver ? (
            <div className="absolute bottom-0 left-3 right-3 h-px bg-sidebar-foreground" />
          ) : null}
        </SidebarSectionHeader>
      ) : recentsDragOver ? (
        <div className="relative h-px">
          <div className="absolute right-3 left-3 h-px bg-sidebar-foreground" />
        </div>
      ) : null}

      {showContent && showEmptyState && collapsed ? (
        <div className="flex flex-col items-center gap-0">
          <Button
            type="button"
            variant="ghost"
            flush
            size="icon-xs"
            onClick={onNewChat}
            aria-label={t("empty.startChat")}
            tooltip={t("empty.startChat")}
            className="rounded-lg"
          >
            <IconEdit className="size-4" />
          </Button>
        </div>
      ) : showContent && showEmptyState ? (
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
      ) : showContent && sessions.length > 0 && collapsed ? (
        <div className="flex flex-col items-center gap-0">
          {sessions.map((session) => (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              key={session.id}
              aria-label={getDisplaySessionTitle(
                session.title,
                t("common:session.defaultTitle"),
              )}
              tooltip={getDisplaySessionTitle(
                session.title,
                t("common:session.defaultTitle"),
              )}
              onClick={() => onSelectSession?.(session.id)}
              className={cn(
                "relative rounded-lg",
                activeSessionId === session.id
                  ? "bg-[var(--sidebar-row-active)] text-sidebar-foreground hover:bg-[var(--sidebar-row-active)]"
                  : "text-sidebar-foreground hover:bg-[var(--sidebar-row-hover)] hover:text-sidebar-foreground",
              )}
            >
              <SidebarChatMenuIcon />
              {session.isRunning ? (
                <SessionActivityIndicator isRunning variant="overlay" />
              ) : session.hasUnread ? (
                <span className="absolute -right-0.5 -top-0.5">
                  <SessionActivityIndicator hasUnread variant="overlay" />
                </span>
              ) : null}
            </Button>
          ))}
        </div>
      ) : !collapsed && sessions.length > 0 ? (
        <CollapseReveal open={isOpen}>
          {sessions.map((session) => {
            const isActive = activeSessionId === session.id;
            return (
              <SidebarChatRow
                key={session.id}
                id={session.id}
                title={session.title}
                branchName={session.branchName}
                remoteHost={session.remoteHost}
                activityAt={session.activityAt}
                showLeadingIcon={showChatIcons}
                quickPinMode={showChatIcons ? "always" : "pinned-only"}
                showTimestamp={showTimestamps}
                showRenameTooltip={false}
                isActive={isActive}
                isRunning={session.isRunning ?? false}
                hasUnread={session.hasUnread ?? false}
                selected={selectedSessionIds?.has(session.id) ?? false}
                selectionEnabled={selectionEnabled}
                selectionActionsDisabled={selectionActionsDisabled}
                selectedSessionIds={selectedSessionIds}
                currentProjectId={null}
                onSelect={onSelectSession}
                onSelectionClear={onSelectionClear}
                onSelectionChange={onSelectionChange}
                onRangeSelect={onRangeSelect}
                onRename={onRenameChat}
                onFork={onForkChat}
                onMarkRead={onMarkChatRead}
                onMarkUnread={onMarkChatUnread}
                onArchive={onArchiveChat}
                onArchiveSelected={onArchiveSelected}
                onPinSelectedToHome={onPinSelectedToHome}
                onUnpinSelectedFromHome={onUnpinSelectedFromHome}
                isSelectionPinnedToHome={isSelectionPinnedToHome}
                onOpenSelectedInWindows={onOpenSelectedInWindows}
                isPinningSelectedToHome={isPinningSelectedToHome}
                onMarkSelectedRead={onMarkSelectedRead}
                onMarkSelectedUnread={onMarkSelectedUnread}
              />
            );
          })}
        </CollapseReveal>
      ) : null}
    </div>
  );
}
