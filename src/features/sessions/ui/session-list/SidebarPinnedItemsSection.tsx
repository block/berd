import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { ProjectIcon } from "@/features/projects/ui/ProjectIcon";
import { SidebarDisplayOptionsMenu } from "./SidebarDisplayOptionsMenu";
import {
  SIDEBAR_SECTION_HEADER_ACTION_REVEAL_CLASS,
  SidebarSectionHeader,
} from "./SidebarSectionHeader";
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
  projectsById,
  onSelectSession,
  onEditProject,
  onArchiveChat,
  onRenameChat,
  onForkChat,
  onMarkChatRead,
  onMarkChatUnread,
  selectedSessionIds,
  selectionEnabled,
  selectionActionsDisabled,
  onSelectionClear,
  onSelectionChange,
  onRangeSelect,
  onArchiveSelected,
  onPinSelectedToHome,
  onUnpinSelectedFromHome,
  isSelectionPinnedToHome,
  onOpenSelectedInWindows,
  isPinningSelectedToHome,
  onMarkSelectedRead,
  onMarkSelectedUnread,
  showChatIcons,
  onShowChatIconsChange,
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
  projectsById: ReadonlyMap<string, ProjectInfo>;
  onSelectSession?: (sessionId: string) => void;
  onEditProject?: (projectId: string) => void;
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
}) {
  const { t } = useTranslation("sidebar");
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const pointerDragCleanupRef = useRef<(() => void) | null>(null);
  const suppressNextClickRef = useRef(false);
  const [dropTarget, setDropTarget] = useState<{
    key: string;
    placement: "before" | "after";
  } | null>(null);
  const dragRef = useRef<{
    key: string;
    pointerId: number;
    startY: number;
    dragging: boolean;
  } | null>(null);
  const itemKey = useCallback(
    (item: SidebarPinnedNavigationItem) => `chat:${item.session.id}`,
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
      const target = Array.from(rowRefs.current.entries()).find(
        ([targetKey, element]) => {
          if (targetKey === drag.key) return false;
          const rect = element.getBoundingClientRect();
          return (
            moveEvent.clientY >= rect.top && moveEvent.clientY <= rect.bottom
          );
        },
      );
      if (target) {
        const rect = target[1].getBoundingClientRect();
        setDropTarget({
          key: target[0],
          placement:
            moveEvent.clientY > rect.top + rect.height / 2 ? "after" : "before",
        });
      } else {
        setDropTarget(null);
      }
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
      setDropTarget(null);
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
            showChatIcons={showChatIcons}
            onShowChatIconsChange={onShowChatIconsChange}
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
                data-pinned-reorder-row={key}
                // Mirrors the row's selected state so the contiguous-selection
                // merge styling can see selected neighbors through this
                // wrapper (see SELECTED_CHAT_ROW_MERGE_CLASS).
                data-selected={
                  selectedSessionIds?.has(item.session.id) ? "" : undefined
                }
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
                className="relative"
              >
                {dropTarget?.key === key && (
                  <div
                    data-testid="pinned-reorder-indicator"
                    className={`pointer-events-none absolute left-3 right-3 z-10 h-0.5 rounded-full bg-border ${
                      dropTarget.placement === "after" ? "bottom-0" : "top-0"
                    }`}
                  />
                )}
                {(() => {
                  const project = item.session.projectId
                    ? projectsById.get(item.session.projectId)
                    : undefined;
                  return (
                    <SidebarChatRow
                      key={`chat:${item.session.id}`}
                      id={item.session.id}
                      title={item.session.title}
                      branchName={item.session.branchName}
                      remoteHost={item.session.remoteHost}
                      activityAt={item.session.activityAt}
                      isActive={activeSessionId === item.session.id}
                      isRunning={item.session.isRunning ?? false}
                      hasUnread={item.session.hasUnread ?? false}
                      selected={
                        selectedSessionIds?.has(item.session.id) ?? false
                      }
                      selectionEnabled={selectionEnabled}
                      selectionActionsDisabled={selectionActionsDisabled}
                      selectedSessionIds={selectedSessionIds}
                      showLeadingIcon={showChatIcons}
                      leadingIcon={
                        project ? (
                          <ProjectIcon
                            icon={project.icon}
                            color={project.color}
                            projectId={project.id}
                            className="size-[18px]"
                            imageClassName="size-[18px] rounded-[4px]"
                          />
                        ) : undefined
                      }
                      leadingIconTestId="sidebar-pinned-chat-icon"
                      contentPaddingClassName={showChatIcons ? "pl-9" : "pl-3"}
                      showTimestamp={showTimestamps}
                      showRenameTooltip={false}
                      quickPinMode={showChatIcons ? "hover-only" : "never"}
                      pointerDragEnabled={false}
                      currentProjectId={item.session.projectId ?? null}
                      onEditProject={onEditProject}
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
                })()}
              </div>
            );
          })
        : null}
    </div>
  );
}
