import { useCallback, useRef, useState } from "react";
import type { ProjectInfo } from "@/features/projects/api/projects";

interface OpenProjectDialogOptions {
  initialWorkingDir?: string | null;
  onCreated?: (projectId: string) => void;
}

interface UseProjectDialogOptions {
  onProjectCreated?: (project: ProjectInfo) => void;
  onProjectSaved?: (project: ProjectInfo) => void;
}

export function useProjectDialog({
  onProjectCreated,
  onProjectSaved,
}: UseProjectDialogOptions = {}) {
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [createProjectInitialWorkingDir, setCreateProjectInitialWorkingDir] =
    useState<string | null>(null);
  const [editingProject, setEditingProject] = useState<ProjectInfo | null>(
    null,
  );
  const pendingProjectCreatedRef = useRef<((projectId: string) => void) | null>(
    null,
  );

  const openCreateProjectDialog = useCallback(
    (options?: OpenProjectDialogOptions) => {
      setEditingProject(null);
      setCreateProjectInitialWorkingDir(options?.initialWorkingDir ?? null);
      pendingProjectCreatedRef.current = options?.onCreated ?? null;
      setCreateProjectOpen(true);
    },
    [],
  );

  const openEditProjectDialog = useCallback((project: ProjectInfo) => {
    setEditingProject(project);
    setCreateProjectInitialWorkingDir(null);
    pendingProjectCreatedRef.current = null;
    setCreateProjectOpen(true);
  }, []);

  const closeCreateProjectDialog = useCallback(() => {
    setCreateProjectOpen(false);
    setEditingProject(null);
    setCreateProjectInitialWorkingDir(null);
    pendingProjectCreatedRef.current = null;
  }, []);

  const handleProjectCreated = useCallback(
    (project: ProjectInfo) => {
      const isNewProject = editingProject === null;

      onProjectSaved?.(project);
      if (isNewProject) {
        onProjectCreated?.(project);
        pendingProjectCreatedRef.current?.(project.id);
      }
      pendingProjectCreatedRef.current = null;
      setCreateProjectInitialWorkingDir(null);
    },
    [editingProject, onProjectCreated, onProjectSaved],
  );

  return {
    closeCreateProjectDialog,
    createProjectInitialWorkingDir,
    createProjectOpen,
    editingProject,
    handleProjectCreated,
    openCreateProjectDialog,
    openEditProjectDialog,
  };
}
