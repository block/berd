import { useCallback, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  IconChevronDown,
  IconChevronRight,
  IconEdit,
} from "@tabler/icons-react";
import type { AppView } from "@/app/AppShell";
import { usePinToHomeWidget } from "@/features/home/hooks/usePinToHomeWidget";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { ProjectIcon } from "@/features/projects/ui/ProjectIcon";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
  SIDEBAR_NAV_ROW_SPACING_CLASS,
  SIDEBAR_NAV_TEXT_CLASS,
} from "@/shared/ui/sidebar-tokens";
import { SidebarChatRow } from "./SidebarChatRow";
import { SidebarUnreadDot } from "./SidebarUnreadDot";
import { useSidebarChatDrag } from "./SidebarChatDragContext";
import { SidebarItemMenu } from "./SidebarItemMenu";

const MAX_VISIBLE_PROJECT_CHATS = 5;
const MAX_EXPANDED_PROJECT_CHATS = 20;
const PROJECT_ROW_TEXT_CLASS =
  "text-sidebar-foreground hover:bg-transparent hover:text-sidebar-foreground";

export interface SidebarSessionItem {
  id: string;
  title: string;
  subtitle?: string;
  updatedAt: string;
  projectId?: string;
  isRunning?: boolean;
  hasUnread?: boolean;
}

export function SidebarProjectSection({
  project,
  projectChats,
  isExpanded,
  toggleProject,
  activeSessionId,
  onSelectSession,
  onNewChatInProject,
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
  onPinSelectedToHome,
  isPinningSelectedToHome = false,
  onMarkSelectedRead,
  onMarkSelectedUnread,
  onNavigate,
  hasMoreSessions = false,
}: {
  project: ProjectInfo;
  projectChats: SidebarSessionItem[];
  isExpanded: boolean;
  toggleProject: (projectId: string) => void;
  activeSessionId?: string | null;
  onSelectSession?: (sessionId: string) => void;
  onNewChatInProject?: (projectId: string) => void;
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
  onPinSelectedToHome?: () => void;
  isPinningSelectedToHome?: boolean;
  onMarkSelectedRead?: () => void;
  onMarkSelectedUnread?: () => void;
  onNavigate?: (view: AppView) => void;
  hasMoreSessions?: boolean;
}) {
  const { t } = useTranslation(["sidebar", "common"]);
  const { draggingSession } = useSidebarChatDrag();
  const [showExpandedChats, setShowExpandedChats] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const projectHasUnread = projectChats.some((session) => session.hasUnread);
  const projectHasChats = projectChats.length > 0;
  // When collapsed, surface unread by swapping the project icon for the dot
  // (the chats — and their own dots — are hidden). When expanded, the per-chat
  // dots carry the signal, so the project row shows its normal icon.
  const showUnreadDot = projectHasUnread && !isExpanded;
  const {
    isPinned: isPinnedToHome,
    isPinning: isPinningToHome,
    pinToHome,
    unpinFromHome,
  } = usePinToHomeWidget({ kind: "project", id: project.id });

  // Only a chat coming from a different group can be moved into this project.
  // Dragging a chat that already lives here resolves to a no-op, so the project
  // stays inert rather than advertising a drop that would not move anything.
  const canAcceptDraggedSession =
    draggingSession != null && draggingSession.fromProjectId !== project.id;

  if (!isExpanded && showExpandedChats) {
    setShowExpandedChats(false);
  }

  const activeChatIndex = activeSessionId
    ? projectChats.findIndex((session) => session.id === activeSessionId)
    : -1;

  // Reveal the rest of the project's chats when the active one is ranked beyond
  // the collapsed top-N cutoff, so its row renders and can be scrolled into view.
  if (
    isExpanded &&
    activeChatIndex >= MAX_VISIBLE_PROJECT_CHATS &&
    !showExpandedChats
  ) {
    setShowExpandedChats(true);
  }

  const handleDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      if (
        canAcceptDraggedSession &&
        e.dataTransfer.types.includes("text/x-session-id")
      ) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOver(true);
      }
    },
    [canAcceptDraggedSession],
  );

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      setDragOver(false);
      if (!canAcceptDraggedSession) return;
      e.preventDefault();
      const sessionId = e.dataTransfer.getData("text/x-session-id");
      if (sessionId) {
        onMoveToProject?.(sessionId, project.id);
        if (!isExpanded) toggleProject(project.id);
      }
    },
    [
      canAcceptDraggedSession,
      onMoveToProject,
      project.id,
      isExpanded,
      toggleProject,
    ],
  );
  const visibleChatLimit = showExpandedChats
    ? MAX_EXPANDED_PROJECT_CHATS
    : MAX_VISIBLE_PROJECT_CHATS;
  const visibleChats = projectChats.slice(0, visibleChatLimit);
  const canRevealLoadedChats =
    !showExpandedChats && projectChats.length > MAX_VISIBLE_PROJECT_CHATS;
  const showHistoryHint =
    showExpandedChats &&
    (projectChats.length > MAX_EXPANDED_PROJECT_CHATS || hasMoreSessions);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop target for drag-and-drop
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className={cn(
          "relative flex items-center group rounded-sm pr-3 hover:bg-sidebar-accent focus-within:bg-sidebar-accent",
          SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
          menuOpen && "bg-sidebar-accent",
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            if (projectHasChats) {
              toggleProject(project.id);
            }
          }}
          aria-expanded={projectHasChats ? isExpanded : undefined}
          className={cn(
            "flex-1 min-w-0 justify-start rounded-sm",
            SIDEBAR_NAV_ROW_SPACING_CLASS,
            SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
            SIDEBAR_NAV_TEXT_CLASS,
            PROJECT_ROW_TEXT_CLASS,
            !projectHasChats && "cursor-default",
          )}
        >
          <span className="relative flex size-[18px] flex-shrink-0 items-center justify-center text-sidebar-foreground">
            {showUnreadDot ? (
              <span
                role="status"
                aria-label={t("status.unreadMessages")}
                className={cn(
                  "absolute flex items-center justify-center",
                  projectHasChats && "group-hover:hidden",
                )}
              >
                <SidebarUnreadDot />
              </span>
            ) : (
              <span
                className={cn(
                  "absolute",
                  projectHasChats && "group-hover:hidden",
                )}
              >
                <ProjectIcon
                  icon={project.icon}
                  color={project.color}
                  projectId={project.id}
                  imageClassName="size-[18px] rounded-[4px]"
                />
              </span>
            )}
            {projectHasChats ? (
              isExpanded ? (
                <IconChevronDown className="absolute hidden size-3 text-muted-foreground group-hover:block" />
              ) : (
                <IconChevronRight className="absolute hidden size-3 text-muted-foreground group-hover:block" />
              )
            ) : null}
          </span>
          <span className="flex-1 min-w-0 truncate text-left">
            {project.name}
          </span>
        </Button>
        <SidebarItemMenu
          label={project.name}
          onOpenChange={setMenuOpen}
          onPinToHome={() =>
            isPinnedToHome ? unpinFromHome() : void pinToHome()
          }
          pinToHomeDisabled={isPinningToHome}
          isPinnedToHome={isPinnedToHome}
          pinToHomeLabel={
            isPinnedToHome
              ? t("common:actions.unpinFromHome")
              : isPinningToHome
                ? t("common:actions.pinningToHome")
                : t("common:actions.pinToHome")
          }
          onEdit={() => onEditProject?.(project.id)}
          onArchive={() => onArchiveProject?.(project.id)}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={(e) => {
            e.stopPropagation();
            onNewChatInProject?.(project.id);
          }}
          title={t("actions.newChatInProject")}
          className={cn(
            "ml-1 size-5 flex-shrink-0 rounded-sm text-muted-foreground hover:text-sidebar-foreground active:text-sidebar-foreground focus-visible:text-sidebar-foreground",
            menuOpen
              ? "visible"
              : "invisible group-hover:visible group-focus-within:visible",
          )}
        >
          <IconEdit className="size-4" />
        </Button>

        {dragOver && (
          <div className="absolute bottom-0 left-3 right-3 h-px bg-sidebar-foreground" />
        )}
      </div>

      {isExpanded && (
        <div className="mt-0.5 space-y-0.5">
          {visibleChats.map((session) => {
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
                nested
                currentProjectId={project.id}
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
          {canRevealLoadedChats && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setShowExpandedChats(true)}
              className="h-auto w-full justify-start gap-1.5 rounded-sm py-1 pl-8 pr-3 text-sm text-sidebar-foreground hover:text-sidebar-foreground"
            >
              <IconChevronRight className="size-3" />
              {t("viewMoreChats")}
            </Button>
          )}
          {showHistoryHint && onNavigate && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => onNavigate("session-history")}
              className="h-auto w-full justify-start rounded-sm py-1 pl-8 pr-3 text-sm text-muted-foreground hover:text-sidebar-foreground"
            >
              {t("olderChatsInHistory")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
