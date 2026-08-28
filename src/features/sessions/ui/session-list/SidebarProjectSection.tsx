import { useCallback, useEffect, useRef, useState } from "react";
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
import { DisclosureButton } from "@/shared/ui/disclosure-button";
import {
  SIDEBAR_GROUP_LABEL_TEXT_CLASS,
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
  SIDEBAR_NAV_ROW_SPACING_CLASS,
  SIDEBAR_NAV_TEXT_CLASS,
  SIDEBAR_ROW_TEXT_DEFAULT_CLASS,
} from "@/shared/ui/sidebar-tokens";
import { SidebarChatRow } from "./SidebarChatRow";
import { SidebarSectionHeaderAction } from "./SidebarSectionHeader";
import { SidebarLeadingIcon } from "./SidebarLeadingIcon";
import { useSidebarChatDrag } from "./SidebarChatDragContext";
import { CollapseReveal } from "@/shared/ui/collapse-reveal";
import { ContextMenu, ContextMenuTrigger } from "@/shared/ui/context-menu";
import {
  SidebarItemContextMenuContent,
  SidebarItemMenu,
  type SidebarItemMenuActions,
} from "./SidebarItemMenu";

const MAX_VISIBLE_PROJECT_CHATS = 5;
const MAX_EXPANDED_PROJECT_CHATS = 20;
const PROJECT_CHAT_LIST_ANIMATION_MS = 300;
const PROJECT_CHAT_LIST_EXPAND_DELAY_MS = 24;
const PROJECT_ROW_TEXT_CLASS = cn(
  SIDEBAR_ROW_TEXT_DEFAULT_CLASS,
  "hover:bg-transparent hover:text-sidebar-foreground",
);
/** Layout-only classes for quiet disclosure actions under a project's chats.
 * Color/hover states come from Button's ghost+flush recipe. */
const PROJECT_CHAT_DISCLOSURE_CLASS = cn(
  "h-auto justify-start rounded-sm py-1",
  SIDEBAR_GROUP_LABEL_TEXT_CLASS,
);

export interface SidebarSessionItem {
  id: string;
  title: string;
  branchName?: string;
  /** SSH host the chat's backend runs on, when remote. */
  remoteHost?: string;
  activityAt?: string | null;
  updatedAt: string;
  lastMessageAt?: string | null;
  projectId?: string | null;
  projectName?: string;
  projectIcon?: string | null;
  projectColor?: string | null;
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
  showTimestamps,
  onNavigate,
  onOpenProject,
  hasMoreSessions: _hasMoreSessions = false,
  dropTargetEnabled = true,
  showExpansionChevron = true,
  emptyState,
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
  showTimestamps: boolean;
  onNavigate?: (view: AppView) => void;
  onOpenProject?: (projectId: string) => void;
  hasMoreSessions?: boolean;
  dropTargetEnabled?: boolean;
  showExpansionChevron?: boolean;
  emptyState?: "no-chats" | "chats-pinned";
}) {
  const { t } = useTranslation(["sidebar", "common"]);
  const { activeSessionDropTargetKey, registerSessionDropTarget } =
    useSidebarChatDrag();
  const dropTargetRef = useRef<HTMLDivElement>(null);
  const dropTargetKey = `project:${project.id}`;
  const [renderProjectChats, setRenderProjectChats] = useState(isExpanded);
  const [showProjectChats, setShowProjectChats] = useState(isExpanded);
  const [showExpandedChats, setShowExpandedChats] = useState(false);
  const [renderExpandedChats, setRenderExpandedChats] = useState(false);
  const [collapsingExpandedChats, setCollapsingExpandedChats] = useState(false);
  const expandProjectChatsTimerRef = useRef<number | null>(null);
  const collapseProjectChatsTimerRef = useRef<number | null>(null);
  const expandExpandedChatsTimerRef = useRef<number | null>(null);
  const collapseExpandedChatsTimerRef = useRef<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const projectHasUnread = projectChats.some((session) => session.hasUnread);
  const projectHasChats = projectChats.length > 0;
  const projectCanExpand = projectHasChats || emptyState != null;
  // When collapsed, surface unread on the project identity because its chat
  // rows are hidden. Expanded chats carry their own activity overlays.
  const showProjectUnread = projectHasUnread && !isExpanded;
  const {
    isPinned: isPinnedToHome,
    isPinning: isPinningToHome,
    pinToHome,
    unpinFromHome,
  } = usePinToHomeWidget({ kind: "project", id: project.id });

  useEffect(() => {
    if (isExpanded) {
      if (collapseProjectChatsTimerRef.current != null) {
        window.clearTimeout(collapseProjectChatsTimerRef.current);
        collapseProjectChatsTimerRef.current = null;
      }
      if (expandProjectChatsTimerRef.current != null) {
        window.clearTimeout(expandProjectChatsTimerRef.current);
      }
      setRenderProjectChats(true);
      expandProjectChatsTimerRef.current = window.setTimeout(() => {
        setShowProjectChats(true);
        expandProjectChatsTimerRef.current = null;
      }, PROJECT_CHAT_LIST_EXPAND_DELAY_MS);
      return;
    }

    if (expandProjectChatsTimerRef.current != null) {
      window.clearTimeout(expandProjectChatsTimerRef.current);
      expandProjectChatsTimerRef.current = null;
    }
    if (collapseProjectChatsTimerRef.current != null) {
      window.clearTimeout(collapseProjectChatsTimerRef.current);
    }
    setShowProjectChats(false);
    setShowExpandedChats(false);
    setRenderExpandedChats(false);
    collapseProjectChatsTimerRef.current = window.setTimeout(() => {
      setRenderProjectChats(false);
      collapseProjectChatsTimerRef.current = null;
    }, PROJECT_CHAT_LIST_ANIMATION_MS);
  }, [isExpanded]);

  useEffect(() => {
    return () => {
      if (expandProjectChatsTimerRef.current != null) {
        window.clearTimeout(expandProjectChatsTimerRef.current);
      }
      if (collapseProjectChatsTimerRef.current != null) {
        window.clearTimeout(collapseProjectChatsTimerRef.current);
      }
      if (expandExpandedChatsTimerRef.current != null) {
        window.clearTimeout(expandExpandedChatsTimerRef.current);
      }
      if (collapseExpandedChatsTimerRef.current != null) {
        window.clearTimeout(collapseExpandedChatsTimerRef.current);
      }
    };
  }, []);

  const revealExpandedChats = () => {
    if (collapseExpandedChatsTimerRef.current != null) {
      window.clearTimeout(collapseExpandedChatsTimerRef.current);
      collapseExpandedChatsTimerRef.current = null;
    }
    if (expandExpandedChatsTimerRef.current != null) {
      window.clearTimeout(expandExpandedChatsTimerRef.current);
    }
    setRenderExpandedChats(true);
    setCollapsingExpandedChats(false);
    expandExpandedChatsTimerRef.current = window.setTimeout(() => {
      setShowExpandedChats(true);
      expandExpandedChatsTimerRef.current = null;
    }, PROJECT_CHAT_LIST_EXPAND_DELAY_MS);
  };

  const collapseExpandedChats = () => {
    if (expandExpandedChatsTimerRef.current != null) {
      window.clearTimeout(expandExpandedChatsTimerRef.current);
      expandExpandedChatsTimerRef.current = null;
    }
    setShowExpandedChats(false);
    setCollapsingExpandedChats(true);
    if (collapseExpandedChatsTimerRef.current != null) {
      window.clearTimeout(collapseExpandedChatsTimerRef.current);
    }
    collapseExpandedChatsTimerRef.current = window.setTimeout(() => {
      setRenderExpandedChats(false);
      setCollapsingExpandedChats(false);
      collapseExpandedChatsTimerRef.current = null;
    }, PROJECT_CHAT_LIST_ANIMATION_MS);
  };

  const handleSessionDrop = useCallback(
    (sessionId: string) => {
      onMoveToProject?.(sessionId, project.id);
      if (!isExpanded) toggleProject(project.id);
    },
    [isExpanded, onMoveToProject, project.id, toggleProject],
  );

  useEffect(() => {
    if (!dropTargetEnabled) return;
    const element = dropTargetRef.current;
    if (!element) return;
    return registerSessionDropTarget({
      key: dropTargetKey,
      kind: "project",
      projectId: project.id,
      element,
      onDrop: handleSessionDrop,
    });
  }, [
    dropTargetEnabled,
    dropTargetKey,
    handleSessionDrop,
    project.id,
    registerSessionDropTarget,
  ]);

  const dragOver = activeSessionDropTargetKey === dropTargetKey;
  const activeChatIndex = activeSessionId
    ? projectChats.findIndex((session) => session.id === activeSessionId)
    : -1;
  const baseVisibleChatLimit = Math.max(
    MAX_VISIBLE_PROJECT_CHATS,
    activeChatIndex >= MAX_VISIBLE_PROJECT_CHATS
      ? Math.min(activeChatIndex + 1, MAX_EXPANDED_PROJECT_CHATS)
      : MAX_VISIBLE_PROJECT_CHATS,
  );
  const baseVisibleChats = projectChats.slice(0, baseVisibleChatLimit);
  const expandedVisibleChats = projectChats.slice(
    baseVisibleChatLimit,
    MAX_EXPANDED_PROJECT_CHATS,
  );
  // Keep “View more” visible while the extra rows are only pre-rendered.
  // Remove it in the same render that begins revealing those rows so there is
  // no empty beat between clicking the control and seeing content expand.
  const canRevealLoadedChats =
    (!showExpandedChats || collapsingExpandedChats) &&
    projectChats.length > baseVisibleChatLimit;
  const canOpenAllProjectChats =
    showExpandedChats &&
    projectChats.length > MAX_EXPANDED_PROJECT_CHATS &&
    onNavigate != null;

  // One action set, two entry points: the row's overflow menu and right-click.
  const projectMenuActions: SidebarItemMenuActions = {
    onPinToHome: () => (isPinnedToHome ? unpinFromHome() : void pinToHome()),
    pinToHomeDisabled: isPinningToHome,
    isPinnedToHome,
    pinToHomeLabel: isPinnedToHome
      ? t("sidebar:actions.unpinProject")
      : isPinningToHome
        ? t("common:actions.pinningToHome")
        : t("sidebar:actions.pinProject"),
    onEdit: () => onEditProject?.(project.id),
    onArchive: () => onArchiveProject?.(project.id),
  };

  return (
    <div
      ref={dropTargetRef}
      data-sidebar-session-drop-target="project"
      data-project-id={project.id}
    >
      <ContextMenu onOpenChange={setContextMenuOpen}>
        <ContextMenuTrigger asChild>
          <div
            data-sidebar-project-row
            className={cn(
              "relative flex items-center group group/chat-row rounded-sm pr-3 hover:bg-[var(--sidebar-row-hover)] focus-within:bg-[var(--sidebar-row-hover)]",
              SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
              (menuOpen || contextMenuOpen) && "bg-[var(--sidebar-row-active)]",
            )}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (projectCanExpand) {
                  toggleProject(project.id);
                } else if (onOpenProject) {
                  onOpenProject(project.id);
                } else {
                  onNavigate?.("projects");
                }
              }}
              aria-expanded={projectCanExpand ? isExpanded : undefined}
              className={cn(
                "flex-1 min-w-0 justify-start rounded-sm",
                SIDEBAR_NAV_ROW_SPACING_CLASS,
                SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
                SIDEBAR_NAV_TEXT_CLASS,
                PROJECT_ROW_TEXT_CLASS,
              )}
            >
              <SidebarLeadingIcon
                hasUnread={showProjectUnread}
                activeLabel={t("status.chatActive")}
                unreadLabel={t("status.unreadMessages")}
                className="text-sidebar-foreground"
              >
                {showExpansionChevron && projectCanExpand ? (
                  <>
                    <span className="group-hover/chat-row:hidden group-focus-within/chat-row:hidden">
                      <ProjectIcon
                        icon={project.icon}
                        color={project.color}
                        projectId={project.id}
                        imageClassName="size-[18px] rounded-[4px]"
                      />
                    </span>
                    {isExpanded ? (
                      <IconChevronDown className="hidden size-3 text-muted-foreground group-hover/chat-row:block group-focus-within/chat-row:block" />
                    ) : (
                      <IconChevronRight className="hidden size-3 text-muted-foreground group-hover/chat-row:block group-focus-within/chat-row:block" />
                    )}
                  </>
                ) : (
                  <ProjectIcon
                    icon={project.icon}
                    color={project.color}
                    projectId={project.id}
                    imageClassName="size-[18px] rounded-[4px]"
                  />
                )}
              </SidebarLeadingIcon>
              <span className="flex-1 min-w-0 truncate text-left">
                {project.name}
              </span>
            </Button>
            <div className="translate-y-px" data-sidebar-drag-ignore>
              <SidebarItemMenu
                label={project.name}
                onOpenChange={setMenuOpen}
                {...projectMenuActions}
              />
            </div>
            <span data-sidebar-drag-ignore className="ml-1 flex flex-shrink-0">
              <SidebarSectionHeaderAction
                icon={IconEdit}
                label={t("actions.newChatInProject")}
                onClick={(e) => {
                  e.stopPropagation();
                  onNewChatInProject?.(project.id);
                }}
                revealClassName={
                  menuOpen || contextMenuOpen
                    ? "visible"
                    : "invisible group-hover:visible group-focus-within:visible"
                }
              />
            </span>

            {dragOver && (
              <div className="absolute bottom-0 left-3 right-3 h-px bg-sidebar-foreground" />
            )}
          </div>
        </ContextMenuTrigger>
        <SidebarItemContextMenuContent {...projectMenuActions} />
      </ContextMenu>

      {renderProjectChats ? (
        <CollapseReveal open={showProjectChats}>
          <div data-sidebar-project-chat-list className="pb-2">
            {emptyState ? (
              <div className="h-7 py-1 pl-[38px] pr-3 text-sm font-normal leading-normal text-muted-foreground">
                {t(
                  emptyState === "chats-pinned"
                    ? "empty.chatsPinned"
                    : "empty.noChats",
                )}
              </div>
            ) : null}
            {baseVisibleChats.map((session) => {
              const isActive = activeSessionId === session.id;
              return (
                <SidebarChatRow
                  key={session.id}
                  id={session.id}
                  title={session.title}
                  branchName={session.branchName}
                  remoteHost={session.remoteHost}
                  activityAt={session.activityAt}
                  isActive={isActive}
                  isRunning={session.isRunning ?? false}
                  hasUnread={session.hasUnread ?? false}
                  selected={selectedSessionIds?.has(session.id) ?? false}
                  selectionEnabled={selectionEnabled}
                  selectionActionsDisabled={selectionActionsDisabled}
                  selectedSessionIds={selectedSessionIds}
                  showLeadingIcon={showChatIcons}
                  showTimestamp={showTimestamps}
                  showRenameTooltip={false}
                  nested
                  currentProjectId={project.id}
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
            {renderExpandedChats ? (
              <CollapseReveal open={showExpandedChats}>
                {expandedVisibleChats.map((session) => {
                  const isActive = activeSessionId === session.id;
                  return (
                    <SidebarChatRow
                      key={session.id}
                      id={session.id}
                      title={session.title}
                      branchName={session.branchName}
                      remoteHost={session.remoteHost}
                      activityAt={session.activityAt}
                      isActive={isActive}
                      isRunning={session.isRunning ?? false}
                      hasUnread={session.hasUnread ?? false}
                      selected={selectedSessionIds?.has(session.id) ?? false}
                      selectionEnabled={selectionEnabled}
                      selectionActionsDisabled={selectionActionsDisabled}
                      selectedSessionIds={selectedSessionIds}
                      showLeadingIcon={showChatIcons}
                      showTimestamp={showTimestamps}
                      showRenameTooltip={false}
                      nested
                      currentProjectId={project.id}
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
                {projectChats.length > MAX_VISIBLE_PROJECT_CHATS ? (
                  <div className="flex items-center pl-[38px] pr-3">
                    <DisclosureButton
                      type="button"
                      surface="sidebar"
                      onClick={collapseExpandedChats}
                      className={PROJECT_CHAT_DISCLOSURE_CLASS}
                    >
                      {t("showLess")}
                    </DisclosureButton>
                    {canOpenAllProjectChats ? (
                      <DisclosureButton
                        type="button"
                        surface="sidebar"
                        onClick={() => onNavigate?.("session-history")}
                        className={cn(PROJECT_CHAT_DISCLOSURE_CLASS, "ml-auto")}
                      >
                        {t("viewAllInHistory")}
                      </DisclosureButton>
                    ) : null}
                  </div>
                ) : null}
              </CollapseReveal>
            ) : null}
            {canRevealLoadedChats && (
              <DisclosureButton
                type="button"
                surface="sidebar"
                onClick={revealExpandedChats}
                className={cn(
                  PROJECT_CHAT_DISCLOSURE_CLASS,
                  "w-full pl-[38px] pr-3",
                  "animate-in fade-in-0 duration-300",
                )}
              >
                {t("viewMoreChats")}
              </DisclosureButton>
            )}
          </div>
        </CollapseReveal>
      ) : null}
    </div>
  );
}
