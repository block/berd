import { useCallback, useEffect, useState, type DragEvent } from "react";
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
import { SidebarChatRow } from "./SidebarChatRow";
import { useSidebarChatDrag } from "./SidebarChatDragContext";
import { SidebarItemMenu } from "./SidebarItemMenu";

const MAX_VISIBLE_PROJECT_CHATS = 5;
const MAX_EXPANDED_PROJECT_CHATS = 20;
const PROJECT_ROW_TEXT_CLASS =
  "text-sidebar-foreground hover:bg-transparent hover:text-sidebar-foreground";

export interface SidebarSessionItem {
  id: string;
  title: string;
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
  const {
    isPinned: isPinnedToHome,
    isPinning: isPinningToHome,
    pinToHome,
  } = usePinToHomeWidget({ kind: "project", id: project.id });

  // Only a chat coming from a different group can be moved into this project.
  // Dragging a chat that already lives here resolves to a no-op, so the project
  // stays inert rather than advertising a drop that would not move anything.
  const canAcceptDraggedSession =
    draggingSession != null && draggingSession.fromProjectId !== project.id;

  useEffect(() => {
    if (!isExpanded) {
      setShowExpandedChats(false);
    }
  }, [isExpanded]);

  const activeChatIndex = activeSessionId
    ? projectChats.findIndex((session) => session.id === activeSessionId)
    : -1;

  // Reveal the rest of the project's chats when the active one is ranked beyond
  // the collapsed top-N cutoff, so its row renders and can be scrolled into view.
  useEffect(() => {
    if (isExpanded && activeChatIndex >= MAX_VISIBLE_PROJECT_CHATS) {
      setShowExpandedChats(true);
    }
  }, [isExpanded, activeChatIndex]);

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
          "relative flex items-center group rounded-md transition-colors duration-200 hover:bg-sidebar-accent focus-within:bg-sidebar-accent",
          menuOpen && "bg-sidebar-accent",
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => toggleProject(project.id)}
          className={cn(
            "flex-1 min-w-0 justify-start gap-2 rounded-md px-3 py-2 text-sm font-light",
            PROJECT_ROW_TEXT_CLASS,
          )}
        >
          <span className="relative flex h-4 w-4 flex-shrink-0 items-center justify-center text-sidebar-foreground">
            <span className="absolute group-hover:opacity-0">
              <ProjectIcon
                icon={project.icon}
                className="size-3.5"
                imageClassName="size-3.5 rounded-[3px]"
              />
            </span>
            {isExpanded ? (
              <IconChevronDown className="absolute size-3 opacity-0 group-hover:opacity-100" />
            ) : (
              <IconChevronRight className="absolute size-3 opacity-0 group-hover:opacity-100" />
            )}
          </span>
          <span className="flex-1 min-w-0 truncate text-left">
            {project.name}
          </span>
        </Button>
        <SidebarItemMenu
          label={project.name}
          onOpenChange={setMenuOpen}
          onPinToHome={() => void pinToHome()}
          pinToHomeDisabled={isPinnedToHome || isPinningToHome}
          pinToHomeLabel={
            isPinnedToHome
              ? t("common:actions.pinnedToHome")
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
            "mr-1 size-6 flex-shrink-0 rounded-md text-sidebar-foreground/40 hover:text-sidebar-foreground active:text-sidebar-foreground focus-visible:text-sidebar-foreground",
            menuOpen
              ? "visible opacity-100"
              : "invisible opacity-0 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100",
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
              className="h-auto w-full justify-start gap-1.5 rounded-md py-1 pl-8 pr-3 text-[11px] text-sidebar-foreground hover:text-sidebar-foreground"
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
              className="h-auto w-full justify-start rounded-md py-1 pl-8 pr-3 text-[11px] text-muted-foreground hover:text-sidebar-foreground"
            >
              {t("olderChatsInHistory")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
