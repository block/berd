import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { getChangedFiles, getGitState } from "@/shared/api/git";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import type { ChangedFile, GitState } from "@/shared/types/git";
import {
  enrichWorkspaceAttachmentWithGitState,
  isSameWorkspacePath,
  normalizeComparableWorkspacePath,
} from "@/features/chat/lib/workspaceAttachments";
import {
  getWorkspaceGitContext,
  type WorkspaceGitContext,
} from "../widgets/WorkspaceIdentity";

export interface WorkspaceGitRuntime {
  workspace: WorkspaceAttachment;
  originalWorkspace: WorkspaceAttachment;
  gitProbePath: string;
  gitState: GitState | undefined;
  gitContext: WorkspaceGitContext;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

export interface WorkspaceChangedFilesRuntime {
  id: string;
  workspace: WorkspaceAttachment;
  workspaceTitle: string;
  repoPath: string;
  currentBranch: string | null;
  dirtyFileCount: number;
  files: ChangedFile[] | undefined;
  isLoading: boolean;
  error: Error | null;
  isLoadingError: boolean;
}

function normalizeQueryError(error: unknown): Error | null {
  if (!error) return null;
  return error instanceof Error ? error : new Error(String(error));
}

function workspaceGitProbePath(workspace: WorkspaceAttachment): string {
  return (
    workspace.worktreePath ??
    workspace.repositoryPath ??
    workspace.path
  ).replace(/\/+$/, "");
}

function uniqueWorkspaceProbePaths(
  workspaces: WorkspaceAttachment[],
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const workspace of workspaces) {
    const path = workspaceGitProbePath(workspace);
    const key = normalizeComparableWorkspacePath(path);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
  }
  return paths;
}

function queryForWorkspacePath<TQuery>(
  path: string,
  paths: string[],
  queries: TQuery[],
): TQuery | undefined {
  const pathKey = normalizeComparableWorkspacePath(path);
  const index = paths.findIndex((candidate) =>
    isSameWorkspacePath(candidate, pathKey),
  );
  return index >= 0 ? queries[index] : undefined;
}

export function useWorkspaceGitRuntimes(
  workspaces: WorkspaceAttachment[],
  enabled = true,
): WorkspaceGitRuntime[] {
  const gitProbePaths = useMemo(
    () => uniqueWorkspaceProbePaths(workspaces),
    [workspaces],
  );
  const gitQueries = useQueries({
    queries: gitProbePaths.map((path) => ({
      queryKey: ["git-state", path],
      queryFn: () => getGitState(path),
      enabled: enabled && Boolean(path),
      retry: false,
      staleTime: Number.POSITIVE_INFINITY,
      refetchOnWindowFocus: "always" as const,
    })),
  });

  return useMemo(
    () =>
      workspaces.map((originalWorkspace) => {
        const gitProbePath = workspaceGitProbePath(originalWorkspace);
        const query = queryForWorkspacePath(
          gitProbePath,
          gitProbePaths,
          gitQueries,
        );
        const gitState = query?.data;
        const workspace = enrichWorkspaceAttachmentWithGitState(
          originalWorkspace,
          gitState,
        );
        const gitContext = getWorkspaceGitContext(workspace, gitState);

        return {
          workspace,
          originalWorkspace,
          gitProbePath,
          gitState,
          gitContext,
          isLoading: query?.isLoading ?? false,
          isFetching: query?.isFetching ?? false,
          error: normalizeQueryError(query?.error),
          refetch: async () => {
            await query?.refetch();
          },
        };
      }),
    [gitProbePaths, gitQueries, workspaces],
  );
}

export function useWorkspaceChangedFilesRuntimes(
  workspaceRuntimes: WorkspaceGitRuntime[],
  enabled = true,
): WorkspaceChangedFilesRuntime[] {
  const changeRoots = useMemo(() => {
    const roots: Array<{ path: string; runtime: WorkspaceGitRuntime }> = [];
    const seen = new Set<string>();
    for (const runtime of workspaceRuntimes) {
      if (
        !runtime.gitState?.isGitRepo ||
        !runtime.gitContext.canUseGitActions
      ) {
        continue;
      }

      const path = runtime.gitContext.actionPath;
      const key = normalizeComparableWorkspacePath(path);
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push({ path, runtime });
    }
    return roots;
  }, [workspaceRuntimes]);

  const changedFilesQueries = useQueries({
    queries: changeRoots.map(({ path }) => ({
      queryKey: ["changed-files", path],
      queryFn: () => getChangedFiles(path),
      enabled: enabled && Boolean(path),
      retry: false,
      staleTime: Number.POSITIVE_INFINITY,
      refetchOnWindowFocus: "always" as const,
    })),
  });

  return useMemo(
    () =>
      changeRoots.map(({ path, runtime }, index) => {
        const query = changedFilesQueries[index];
        return {
          id: normalizeComparableWorkspacePath(path),
          workspace: runtime.workspace,
          workspaceTitle: runtime.gitContext.workspaceTitle,
          repoPath: path,
          currentBranch:
            runtime.gitContext.branch ??
            runtime.gitState?.currentBranch ??
            null,
          dirtyFileCount: runtime.gitState?.dirtyFileCount ?? 0,
          files: query?.data,
          isLoading: query?.isLoading ?? false,
          error: normalizeQueryError(query?.error),
          isLoadingError: query?.isLoadingError ?? false,
        };
      }),
    [changeRoots, changedFilesQueries],
  );
}
