import { useState } from "react";
import type { AppView } from "@/app/AppShell";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { ProjectColorSwatch } from "@/features/projects/ui/ProjectColorSwatch";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  SidebarProjectSection,
  type SidebarSessionItem,
} from "./SidebarProjectSection";

export function SidebarProjectList({
  projects,
  projectSessionsByProject,
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
  onReorderProject,
  hasMoreSessions = false,
}: {
  projects: ProjectInfo[];
  projectSessionsByProject: Record<string, SidebarSessionItem[]>;
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
  onReorderProject?: (fromId: string, toId: string) => void;
  hasMoreSessions?: boolean;
}) {
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [dropTargetProjectId, setDropTargetProjectId] = useState<string | null>(
    null,
  );

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1">
        {projects.map((project) => (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            key={project.id}
            title={project.name}
            onClick={() => onNavigate?.("projects")}
            className="rounded-lg text-sidebar-foreground hover:bg-transparent hover:text-sidebar-foreground"
          >
            <ProjectColorSwatch color={project.color} projectId={project.id} />
          </Button>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {projects.map((project) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop reorder target
        <div
          key={project.id}
          draggable
          onDragStart={(e) => {
            if (e.dataTransfer.types.includes("text/x-session-id")) return;
            e.dataTransfer.setData("text/x-project-id", project.id);
            e.dataTransfer.effectAllowed = "move";
            setDraggedProjectId(project.id);
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("text/x-project-id")) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (project.id !== draggedProjectId) {
                setDropTargetProjectId(project.id);
              }
            }
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setDropTargetProjectId((prev) =>
                prev === project.id ? null : prev,
              );
            }
          }}
          onDrop={(e) => {
            const fromId = e.dataTransfer.getData("text/x-project-id");
            if (fromId && fromId !== project.id) {
              e.preventDefault();
              e.stopPropagation();
              onReorderProject?.(fromId, project.id);
            }
            setDraggedProjectId(null);
            setDropTargetProjectId(null);
          }}
          onDragEnd={() => {
            setDraggedProjectId(null);
            setDropTargetProjectId(null);
          }}
          className={cn(
            "relative",
            draggedProjectId === project.id && "opacity-40",
          )}
        >
          {dropTargetProjectId === project.id &&
            draggedProjectId !== project.id && (
              <div className="absolute top-0 left-3 right-3 h-0.5 rounded-full bg-sidebar-foreground" />
            )}
          <SidebarProjectSection
            project={project}
            projectChats={projectSessionsByProject[project.id] ?? []}
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
            onMarkChatRead={onMarkChatRead}
            onMarkChatUnread={onMarkChatUnread}
            onMoveToProject={onMoveToProject}
            selectedSessionIds={selectedSessionIds}
            selectionEnabled={selectionEnabled}
            selectionActionsDisabled={selectionActionsDisabled}
            onSelectionClear={onSelectionClear}
            onSelectionChange={onSelectionChange}
            onArchiveSelected={onArchiveSelected}
            onMarkSelectedRead={onMarkSelectedRead}
            onMarkSelectedUnread={onMarkSelectedUnread}
            hasMoreSessions={hasMoreSessions}
          />
        </div>
      ))}
    </div>
  );
}
