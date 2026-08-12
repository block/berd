import { useMemo } from "react";
import {
  getMultiWorkspaceEnabled,
  useMultiWorkspacePreference,
} from "@/features/workspaces/multiWorkspacePreference";
import {
  type ProjectInfo,
  type ProjectWorkspace,
  normalizeProjectWorkspaces,
} from "@/features/projects/api/projects";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import {
  getActiveWorkspaceAttachment,
  getIncludedWorkspaceAttachments,
  getWorkspaceAttachments,
  isSameWorkspacePath,
  normalizeWorkspacePath,
  workspaceAttachmentIdForPath,
} from "@/features/chat/lib/workspaceAttachments";

export type WorkspaceMode = "single" | "multi";

export interface WorkspaceSet<
  TWorkspace extends WorkspaceAttachment = WorkspaceAttachment,
> {
  mode: WorkspaceMode;
  workspaces: TWorkspace[];
  primary: TWorkspace | null;
}

interface ChatWorkspaceOptions {
  activePath?: string | null;
}

export interface WorkspaceRepository {
  mode: WorkspaceMode;
  chatWorkspaces(
    session:
      | {
          workingDir?: string | null;
          workspaceAttachments?: WorkspaceAttachment[];
          activeWorkspaceId?: string | null;
          messageCount?: number;
        }
      | null
      | undefined,
    options?: ChatWorkspaceOptions,
  ): WorkspaceSet;
  projectWorkspaces(
    project:
      | Pick<ProjectInfo, "projectWorkspaces" | "workingDirs" | "useWorktrees">
      | null
      | undefined,
  ): WorkspaceSet<ProjectWorkspace>;
}

function workspaceFromPath(
  path: string | null | undefined,
  usedByAgent = false,
): WorkspaceAttachment | null {
  const normalizedPath = normalizeWorkspacePath(path);
  if (!normalizedPath) {
    return null;
  }

  return {
    id: workspaceAttachmentIdForPath(normalizedPath),
    path: normalizedPath,
    kind: "directory",
    source: "inferred",
    branch: null,
    usedByAgent,
  };
}

function workspaceSet<TWorkspace extends WorkspaceAttachment>(
  mode: WorkspaceMode,
  workspaces: TWorkspace[],
): WorkspaceSet<TWorkspace> {
  return {
    mode,
    workspaces,
    primary: workspaces[0] ?? null,
  };
}

function primaryWorkspaceForPath<TWorkspace extends WorkspaceAttachment>(
  workspaces: TWorkspace[],
  path: string | null | undefined,
): TWorkspace | WorkspaceAttachment | null {
  const normalizedPath = normalizeWorkspacePath(path);
  if (!normalizedPath) {
    return null;
  }
  return (
    workspaces.find((workspace) =>
      isSameWorkspacePath(workspace.path, normalizedPath),
    ) ?? workspaceFromPath(normalizedPath)
  );
}

function normalizedProjectWorkspaces(
  project:
    | Pick<ProjectInfo, "projectWorkspaces" | "workingDirs" | "useWorktrees">
    | null
    | undefined,
): ProjectWorkspace[] {
  return normalizeProjectWorkspaces(
    project?.projectWorkspaces,
    project?.workingDirs,
    project?.useWorktrees,
  );
}

function createWorkspaceRepository(mode: WorkspaceMode): WorkspaceRepository {
  const isMulti = mode === "multi";

  return {
    mode,
    chatWorkspaces(session, options) {
      if (isMulti) {
        const workspaces = getIncludedWorkspaceAttachments(session);
        const activeAttachment = session
          ? getActiveWorkspaceAttachment(session)
          : null;
        const primary =
          primaryWorkspaceForPath(workspaces, options?.activePath) ??
          activeAttachment ??
          workspaces[0] ??
          workspaceFromPath(
            session?.workingDir,
            (session?.messageCount ?? 0) > 0,
          ) ??
          null;
        return {
          ...workspaceSet(mode, workspaces),
          primary,
        };
      }

      const activeAttachment = session
        ? getActiveWorkspaceAttachment(session)
        : null;
      const sessionAttachments = session
        ? getWorkspaceAttachments(session)
        : [];
      const path =
        normalizeWorkspacePath(options?.activePath) ??
        activeAttachment?.path ??
        normalizeWorkspacePath(session?.workingDir) ??
        null;
      const matchingAttachment = sessionAttachments.find(
        (attachment) =>
          attachment.source !== "excluded" &&
          isSameWorkspacePath(attachment.path, path),
      );
      const workspace =
        activeAttachment && isSameWorkspacePath(activeAttachment.path, path)
          ? activeAttachment
          : (matchingAttachment ??
            workspaceFromPath(path, (session?.messageCount ?? 0) > 0));
      return workspaceSet(mode, workspace ? [workspace] : []);
    },
    projectWorkspaces(project) {
      const workspaces = normalizedProjectWorkspaces(project);
      return workspaceSet(mode, isMulti ? workspaces : workspaces.slice(0, 1));
    },
  };
}

export function getWorkspaceRepository(): WorkspaceRepository {
  return createWorkspaceRepository(
    getMultiWorkspaceEnabled() ? "multi" : "single",
  );
}

export function useWorkspaceRepository(): WorkspaceRepository {
  const { enabled: isMulti } = useMultiWorkspacePreference();
  return useMemo(
    () => createWorkspaceRepository(isMulti ? "multi" : "single"),
    [isMulti],
  );
}
