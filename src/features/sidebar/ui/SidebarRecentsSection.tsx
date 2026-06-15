import { useCallback, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronDown, IconEdit, IconPlus } from "@tabler/icons-react";
import { History } from "lucide-react";
import type { AppView } from "@/app/AppShell";
import { SidebarChatMenuIcon } from "./SidebarChatMenuIcon";
import { getDisplaySessionTitle } from "@/features/chat/lib/sessionTitle";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS,
  SIDEBAR_ROW_HEIGHT_CLASS,
  SIDEBAR_SECTION_DIVIDER_INSET_CLASS,
  SIDEBAR_SECTION_DIVIDER_TOP_CLASS,
  SIDEBAR_SECTION_ACTION_PILL_CLASS,
  SIDEBAR_SECTION_HEADER_ROW_CLASS,
} from "@/shared/ui/sidebar-tokens";
import { SessionActivityIndicator } from "@/shared/ui/SessionActivityIndicator";
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
  isOpen,
  onToggleOpen,
  sectionHeaderTextClass,
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
  isOpen: boolean;
  onToggleOpen: () => void;
  sectionHeaderTextClass: string;
}) {
  const { t } = useTranslation(["sidebar", "common"]);
  const { draggingSession } = useSidebarChatDrag();
  const [recentsDragOver, setRecentsDragOver] = useState(false);
  const showContent = collapsed || isOpen;

  // Recents only accepts chats that currently belong to a project (moving them
  // back out). A chat already in Recents has nowhere to move here, so the drop
  // zone stays inert instead of suggesting an action that does nothing.
  const canAcceptDraggedSession =
    draggingSession != null && draggingSession.fromProjectId != null;

  const handleRecentsDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      if (
        canAcceptDraggedSession &&
        e.dataTransfer.types.includes("text/x-session-id")
      ) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setRecentsDragOver(true);
      }
    },
    [canAcceptDraggedSession],
  );

  const handleRecentsDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setRecentsDragOver(false);
    }
  }, []);

  const handleRecentsDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      setRecentsDragOver(false);
      if (!canAcceptDraggedSession) return;
      e.preventDefault();
      const sessionId = e.dataTransfer.getData("text/x-session-id");
      if (sessionId) {
        onMoveToProject?.(sessionId, null);
      }
    },
    [canAcceptDraggedSession, onMoveToProject],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop target for drag-and-drop
    <div
      onDragOver={handleRecentsDragOver}
      onDragLeave={handleRecentsDragLeave}
      onDrop={handleRecentsDrop}
    >
      <div
        className={cn(
          SIDEBAR_SECTION_DIVIDER_INSET_CLASS,
          SIDEBAR_SECTION_DIVIDER_TOP_CLASS,
          "border-t border-sidebar-border/80",
        )}
        aria-hidden
      />
      <div
        className={cn(
          "relative group/chats-header flex items-center",
          collapsed
            ? "px-0 pt-0 pb-1 justify-center"
            : SIDEBAR_SECTION_HEADER_ROW_CLASS,
        )}
      >
        {!collapsed && (
          <button
            type="button"
            onClick={onToggleOpen}
            aria-expanded={isOpen}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-0.5 rounded-sm py-1 text-left transition-colors hover:text-sidebar-foreground",
              labelTransition,
              labelVisible
                ? "opacity-100 w-auto"
                : "opacity-0 w-0 overflow-hidden",
            )}
          >
            <span className={cn("truncate", sectionHeaderTextClass)}>
              {t("sections.recents")}
            </span>
            <IconChevronDown
              className={cn(
                "invisible size-3 shrink-0 text-muted-foreground transition-transform duration-150",
                "group-hover/chats-header:visible",
                !isOpen && "-rotate-90",
              )}
            />
          </button>
        )}
        {!collapsed && onNewChat && !showEmptyState && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onNewChat}
            aria-label={t("empty.startChat")}
            title={t("empty.startChat")}
            className={cn(
              SIDEBAR_SECTION_ACTION_PILL_CLASS,
              "size-5 bg-transparent p-0 text-muted-foreground hover:bg-sidebar-section-action-bg hover:text-sidebar-foreground focus-visible:bg-sidebar-section-action-bg focus-visible:text-sidebar-foreground",
              "invisible pointer-events-none group-hover/chats-header:visible group-hover/chats-header:pointer-events-auto group-focus-within/chats-header:visible group-focus-within/chats-header:pointer-events-auto focus-visible:visible focus-visible:pointer-events-auto",
            )}
          >
            <IconPlus className="size-4" />
          </Button>
        )}

        {recentsDragOver && (
          <div className="absolute bottom-0 left-3 right-3 h-px bg-sidebar-foreground" />
        )}
      </div>

      {showContent && showEmptyState && collapsed ? (
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
      ) : showContent && showEmptyState ? (
        <div className="space-y-0.5">
          <Button
            type="button"
            variant="quiet"
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
      ) : showContent && sessions.length > 0 && collapsed ? (
        <div className="flex flex-col items-center gap-1">
          {sessions.map((session) => (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              key={session.id}
              title={getDisplaySessionTitle(
                session.title,
                t("common:session.defaultTitle"),
              )}
              onClick={() => onSelectSession?.(session.id)}
              className={cn(
                "relative rounded-lg",
                activeSessionId === session.id
                  ? "bg-transparent text-sidebar-foreground hover:bg-transparent"
                  : "text-sidebar-foreground hover:text-sidebar-foreground",
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
      ) : showContent && sessions.length > 0 ? (
        <div className="space-y-0.5 pb-2">
          {sessions.map((session) => {
            const isActive = activeSessionId === session.id;
            return (
              <SidebarChatRow
                key={session.id}
                id={session.id}
                title={session.title}
                subtitle={session.subtitle}
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
                onRename={onRenameChat}
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
          {onNavigate && (
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
          )}
        </div>
      ) : null}
    </div>
  );
}
