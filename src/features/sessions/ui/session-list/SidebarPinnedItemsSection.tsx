import { useCallback, useEffect, useRef, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AppView } from "@/app/AppShell";
import { SidebarDisplayOptionsMenu } from "./SidebarDisplayOptionsMenu";
import {
  SIDEBAR_SECTION_HEADER_ACTION_REVEAL_CLASS,
  SidebarSectionHeader,
} from "./SidebarSectionHeader";
import { SidebarProjectSection } from "./SidebarProjectSection";
import { SidebarChatRow } from "./SidebarChatRow";
import type { SidebarPinnedNavigationItem } from "./SidebarProjectsSection";

export function SidebarPinnedItemsSection({
  items,
  isOpen,
  onToggleOpen,
  onReorder,
  collapsed,
  labelTransition,
  labelVisible,
  activeSessionId,
  projectSessionsByProject,
  expandedProjects,
  toggleProject,
  onNavigate,
  onOpenProject,
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
  selectionEnabled,
  selectionActionsDisabled,
  onSelectionClear,
  onSelectionChange,
  onArchiveSelected,
  onPinSelectedToHome,
  isPinningSelectedToHome,
  onMarkSelectedRead,
  onMarkSelectedUnread,
  showTimestamps,
  onShowTimestampsChange,
}: {
  items: SidebarPinnedNavigationItem[];
  isOpen: boolean;
  onToggleOpen: () => void;
  onReorder?: (
    fromKey: string,
    toKey: string,
    placement: "before" | "after",
  ) => void;
  collapsed: boolean;
  labelTransition: string;
  labelVisible: boolean;
  activeSessionId?: string | null;
  projectSessionsByProject: Record<
    string,
    import("./SidebarProjectSection").SidebarSessionItem[]
  >;
  expandedProjects: Record<string, boolean>;
  toggleProject: (projectId: string) => void;
  onNavigate?: (view: AppView) => void;
  onOpenProject?: (projectId: string) => void;
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
  onArchiveSelected?: () => void;
  onPinSelectedToHome?: () => void;
  isPinningSelectedToHome?: boolean;
  onMarkSelectedRead?: () => void;
  onMarkSelectedUnread?: () => void;
  showTimestamps: boolean;
  onShowTimestampsChange: (show: boolean) => void;
}) {
  const { t } = useTranslation("sidebar");
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const pointerDragCleanupRef = useRef<(() => void) | null>(null);
  const suppressNextClickRef = useRef(false);
  const dragRef = useRef<{
    key: string;
    pointerId: number;
    startY: number;
    dragging: boolean;
  } | null>(null);
  const itemKey = useCallback(
    (item: SidebarPinnedNavigationItem) =>
      item.kind === "project"
        ? `project:${item.project.id}`
        : `chat:${item.session.id}`,
    [],
  );
  useEffect(
    () => () => {
      pointerDragCleanupRef.current?.();
    },
    [],
  );

  const handlePointerDown = (
    key: string,
    event: PointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0 || !onReorder) return;
    if (
      event.target instanceof Element &&
      event.target.closest("[data-sidebar-drag-ignore]")
    ) {
      return;
    }
    pointerDragCleanupRef.current?.();
    dragRef.current = {
      key,
      pointerId: event.pointerId,
      startY: event.clientY,
      dragging: false,
    };
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== moveEvent.pointerId) return;
      if (!drag.dragging && Math.abs(moveEvent.clientY - drag.startY) < 4)
        return;
      drag.dragging = true;
      suppressNextClickRef.current = true;
      moveEvent.preventDefault();
    };
    const finish = (upEvent: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== upEvent.pointerId) return;
      if (drag.dragging) {
        const target = Array.from(rowRefs.current.entries()).find(
          ([targetKey, element]) => {
            if (targetKey === drag.key) return false;
            const rect = element.getBoundingClientRect();
            return (
              upEvent.clientY >= rect.top && upEvent.clientY <= rect.bottom
            );
          },
        );
        if (target) {
          const rect = target[1].getBoundingClientRect();
          onReorder(
            drag.key,
            target[0],
            upEvent.clientY > rect.top + rect.height / 2 ? "after" : "before",
          );
        }
      }
      dragRef.current = null;
      pointerDragCleanupRef.current?.();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    pointerDragCleanupRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      pointerDragCleanupRef.current = null;
    };
  };
  if (items.length === 0) return null;

  return (
    <div data-testid="sidebar-pinned-section" className="pb-1">
      <SidebarSectionHeader
        label={t("sections.pinned")}
        collapsed={collapsed}
        labelTransition={labelTransition}
        labelVisible={labelVisible}
        labelClassName="!text-sm font-normal leading-normal"
        onToggleOpen={onToggleOpen}
        isOpen={isOpen}
        actions={
          <SidebarDisplayOptionsMenu
            labelKey="actions.pinnedDisplayOptions"
            showTimestamps={showTimestamps}
            onShowTimestampsChange={onShowTimestampsChange}
            className={SIDEBAR_SECTION_HEADER_ACTION_REVEAL_CLASS}
          />
        }
      />
      {!collapsed && isOpen
        ? items.map((item) => {
            const key = itemKey(item);
            return (
              <div
                key={key}
                ref={(element) => {
                  if (element) rowRefs.current.set(key, element);
                  else rowRefs.current.delete(key);
                }}
                onPointerDown={(event) => handlePointerDown(key, event)}
                onClickCapture={(event) => {
                  if (!suppressNextClickRef.current) return;
                  suppressNextClickRef.current = false;
                  event.preventDefault();
                  event.stopPropagation();
                }}
              >
                {item.kind === "project" ? (
                  <SidebarProjectSection
                    key={`project:${item.project.id}`}
                    project={item.project}
                    projectChats={
                      projectSessionsByProject[item.project.id] ?? []
                    }
                    isExpanded={expandedProjects[item.project.id] ?? false}
                    toggleProject={toggleProject}
                    activeSessionId={activeSessionId}
                    onNavigate={onNavigate}
                    onOpenProject={onOpenProject}
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
                    showChatIcons={false}
                    showTimestamps={showTimestamps}
                    dropTargetEnabled={false}
                    showExpansionChevron
                  />
                ) : (
                  <SidebarChatRow
                    key={`chat:${item.session.id}`}
                    id={item.session.id}
                    title={item.session.title}
                    branchName={item.session.branchName}
                    activityAt={item.session.activityAt}
                    isActive={activeSessionId === item.session.id}
                    isRunning={item.session.isRunning ?? false}
                    hasUnread={item.session.hasUnread ?? false}
                    selected={selectedSessionIds?.has(item.session.id) ?? false}
                    selectionEnabled={selectionEnabled}
                    selectionActionsDisabled={selectionActionsDisabled}
                    selectedSessionIds={selectedSessionIds}
                    showLeadingIcon
                    leadingIconTestId="sidebar-pinned-chat-icon"
                    contentPaddingClassName="pl-9"
                    showTimestamp={showTimestamps}
                    showRenameTooltip={false}
                    quickPinMode="never"
                    pointerDragEnabled={false}
                    currentProjectId={item.session.projectId ?? null}
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
                )}
              </div>
            );
          })
        : null}
    </div>
  );
}
