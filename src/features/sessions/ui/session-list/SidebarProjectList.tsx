import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import type { AppView } from "@/app/AppShell";
import type { ProjectInfo } from "@/features/projects/api/projects";
import {
  findSidebarProjectReorderTarget,
  type SidebarProjectReorderTarget,
} from "@/features/sidebar/lib/sidebarPointerDragRegistry";
import {
  clearPointerDragClickSuppression,
  hasExceededPointerDragThreshold,
  isPrimaryPointerButton,
  schedulePointerDragClickSuppressionReset,
} from "@/features/sidebar/lib/pointerDrag";
import { ProjectIcon } from "@/features/projects/ui/ProjectIcon";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  SidebarProjectSection,
  type SidebarSessionItem,
} from "./SidebarProjectSection";

interface ProjectPointerDragState {
  projectId: string;
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
}

interface ProjectDropTargetState {
  projectId: string;
  placement: "before" | "after";
}

export function SidebarProjectList({
  projects,
  projectSessionsByProject,
  pinnedChatProjectIds,
  expandedProjects,
  toggleProject,
  collapsed,
  activeSessionId,
  onNavigate,
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
  onReorderProject,
  hasMoreSessions = false,
  dropTargetsEnabled = true,
}: {
  projects: ProjectInfo[];
  projectSessionsByProject: Record<string, SidebarSessionItem[]>;
  pinnedChatProjectIds?: ReadonlySet<string>;
  expandedProjects: Record<string, boolean>;
  toggleProject: (projectId: string) => void;
  collapsed: boolean;
  activeSessionId?: string | null;
  onNavigate?: (view: AppView) => void;
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
  onReorderProject?: (
    fromId: string,
    toId: string,
    placement?: "before" | "after",
  ) => void;
  hasMoreSessions?: boolean;
  dropTargetsEnabled?: boolean;
}) {
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [dropTargetProject, setDropTargetProject] =
    useState<ProjectDropTargetState | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const pointerDragRef = useRef<ProjectPointerDragState | null>(null);
  const pointerDragCleanupRef = useRef<(() => void) | null>(null);
  const suppressNextClickRef = useRef(false);
  const suppressNextClickResetRef = useRef<number | null>(null);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const onReorderProjectRef = useRef(onReorderProject);
  onReorderProjectRef.current = onReorderProject;

  const getProjectTargets = useCallback((): SidebarProjectReorderTarget[] => {
    return projectsRef.current.flatMap((project) => {
      const element = rowRefs.current.get(project.id);
      if (!element) return [];
      return [{ projectId: project.id, rect: element.getBoundingClientRect() }];
    });
  }, []);

  const getProjectDropTarget = useCallback(
    (draggedId: string, clientX: number, clientY: number) =>
      findSidebarProjectReorderTarget(
        getProjectTargets(),
        draggedId,
        clientX,
        clientY,
      ),
    [getProjectTargets],
  );

  const clearPointerDragListeners = () => {
    pointerDragCleanupRef.current?.();
    pointerDragCleanupRef.current = null;
  };

  const endProjectPointerDrag = () => {
    clearPointerDragListeners();
    pointerDragRef.current = null;
    setDraggedProjectId(null);
    setDropTargetProject(null);
    if (suppressNextClickRef.current) {
      schedulePointerDragClickSuppressionReset(
        suppressNextClickRef,
        suppressNextClickResetRef,
      );
    }
  };

  useEffect(() => {
    return () => {
      pointerDragCleanupRef.current?.();
      clearPointerDragClickSuppression(
        suppressNextClickRef,
        suppressNextClickResetRef,
      );
    };
  }, []);

  const handleProjectPointerDown = (
    projectId: string,
    event: PointerEvent<HTMLDivElement>,
  ) => {
    if (!isPrimaryPointerButton(event)) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(
        "[data-sidebar-drag-ignore], [data-sidebar-chat-draggable]",
      )
    ) {
      return;
    }

    clearPointerDragListeners();
    pointerDragRef.current = {
      projectId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || moveEvent.pointerId !== drag.pointerId) return;

      const isDragging =
        drag.dragging ||
        hasExceededPointerDragThreshold({
          startX: drag.startX,
          startY: drag.startY,
          clientX: moveEvent.clientX,
          clientY: moveEvent.clientY,
        });

      if (!isDragging) return;

      moveEvent.preventDefault();
      suppressNextClickRef.current = true;
      if (!drag.dragging) {
        pointerDragRef.current = { ...drag, dragging: true };
        setDraggedProjectId(drag.projectId);
      }

      setDropTargetProject(
        getProjectDropTarget(
          drag.projectId,
          moveEvent.clientX,
          moveEvent.clientY,
        ),
      );
    };

    const handlePointerUp = (upEvent: globalThis.PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || upEvent.pointerId !== drag.pointerId) return;

      if (drag.dragging) {
        upEvent.preventDefault();
        const finalTarget = getProjectDropTarget(
          drag.projectId,
          upEvent.clientX,
          upEvent.clientY,
        );
        if (finalTarget) {
          onReorderProjectRef.current?.(
            drag.projectId,
            finalTarget.projectId,
            finalTarget.placement,
          );
        }
      }
      endProjectPointerDrag();
    };

    const handlePointerCancel = (cancelEvent: globalThis.PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || cancelEvent.pointerId !== drag.pointerId) return;
      endProjectPointerDrag();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    pointerDragCleanupRef.current = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };
  };

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-0">
        {projects.map((project) => (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            key={project.id}
            aria-label={project.name}
            tooltip={project.name}
            onClick={() => onNavigate?.("projects")}
            className="rounded-lg text-sidebar-foreground hover:bg-transparent hover:text-sidebar-foreground"
          >
            <ProjectIcon
              icon={project.icon}
              color={project.color}
              projectId={project.id}
              className="size-[18px]"
              imageClassName="size-4 rounded-[4px]"
            />
          </Button>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-0">
      {projects.map((project) => (
        <div
          key={project.id}
          data-sidebar-project-draggable
          data-project-id={project.id}
          ref={(element) => {
            if (element) {
              rowRefs.current.set(project.id, element);
            } else {
              rowRefs.current.delete(project.id);
            }
          }}
          onPointerDown={(event) => handleProjectPointerDown(project.id, event)}
          onClickCapture={(event) => {
            if (!suppressNextClickRef.current) return;
            clearPointerDragClickSuppression(
              suppressNextClickRef,
              suppressNextClickResetRef,
            );
            event.preventDefault();
            event.stopPropagation();
          }}
          className={cn(
            "relative",
            draggedProjectId === project.id && "opacity-40",
          )}
        >
          {dropTargetProject?.projectId === project.id &&
            draggedProjectId !== project.id && (
              <div
                className={cn(
                  "absolute left-3 right-3 h-0.5 rounded-full bg-sidebar-foreground",
                  dropTargetProject.placement === "after"
                    ? "bottom-0"
                    : "top-0",
                )}
              />
            )}
          <SidebarProjectSection
            project={project}
            projectChats={projectSessionsByProject[project.id] ?? []}
            emptyState={
              (projectSessionsByProject[project.id]?.length ?? 0) === 0
                ? pinnedChatProjectIds?.has(project.id)
                  ? "chats-pinned"
                  : "no-chats"
                : undefined
            }
            isExpanded={expandedProjects[project.id] ?? false}
            toggleProject={toggleProject}
            activeSessionId={activeSessionId}
            onNavigate={onNavigate}
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
            onRangeSelect={onRangeSelect}
            onArchiveSelected={onArchiveSelected}
            onPinSelectedToHome={onPinSelectedToHome}
            onUnpinSelectedFromHome={onUnpinSelectedFromHome}
            isSelectionPinnedToHome={isSelectionPinnedToHome}
            onOpenSelectedInWindows={onOpenSelectedInWindows}
            isPinningSelectedToHome={isPinningSelectedToHome}
            onMarkSelectedRead={onMarkSelectedRead}
            onMarkSelectedUnread={onMarkSelectedUnread}
            showChatIcons={showChatIcons}
            showTimestamps={showTimestamps}
            hasMoreSessions={hasMoreSessions}
            dropTargetEnabled={dropTargetsEnabled}
          />
        </div>
      ))}
    </div>
  );
}
