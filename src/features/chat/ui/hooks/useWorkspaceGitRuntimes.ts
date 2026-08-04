import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { getChangedFiles, getGitState } from "@/shared/api/git";
import { useHomeDir } from "@/shared/hooks/useHomeDir";
import {
  changedFilesQueryKey,
  gitStateQueryKey,
} from "@/shared/lib/gitStateQueryKey";
import { expandHomePath, isHomeRelativePath } from "@/shared/lib/homePath";
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
  /** `workspace` with home-relative (`~`) paths expanded to absolute. Use for
   *  comparisons against `gitState`/`gitContext` paths, which are always
   *  absolute — e.g. preserving a subdirectory suffix across a worktree
   *  switch. `workspace` keeps the session's original spelling so lookups by
   *  path/id still resolve. */
  comparableWorkspace: WorkspaceAttachment;
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

function expandGitDerivationPath(
  path: string | null | undefined,
  homeDir: string | null,
): string | null | undefined {
  if (!path || homeDir === null || !isHomeRelativePath(path)) return path;
  return expandHomePath(path, homeDir);
}

/**
 * Build a workspace whose `~`-spelled paths are expanded to absolute for the
 * git-state derivation. `gitState`'s worktree/main paths are always absolute,
 * but `classifyWorkspaceAttachmentIfInGitState`/`getWorkspaceGitContext`
 * compare `workspace.path` verbatim (their normalizer does not expand `~`), so
 * a home-relative included workspace fetches valid git state under its expanded
 * query key yet still fails classification — leaving it non-git-backed with no
 * git actions or changed-file root. Deriving against the expanded spelling
 * fixes the match; the caller restores the original `path` on the returned
 * runtime so session lookups keyed by path/id still resolve.
 */
function expandWorkspaceForGitDerivation(
  workspace: WorkspaceAttachment,
  homeDir: string | null,
): WorkspaceAttachment {
  if (homeDir === null) return workspace;
  const path =
    expandGitDerivationPath(workspace.path, homeDir) ?? workspace.path;
  const worktreePath = expandGitDerivationPath(workspace.worktreePath, homeDir);
  const repositoryPath = expandGitDerivationPath(
    workspace.repositoryPath,
    homeDir,
  );
  if (
    path === workspace.path &&
    worktreePath === workspace.worktreePath &&
    repositoryPath === workspace.repositoryPath
  ) {
    return workspace;
  }
  const expanded: WorkspaceAttachment = { ...workspace, path };
  if (worktreePath) {
    expanded.worktreePath = worktreePath;
  }
  if (repositoryPath) {
    expanded.repositoryPath = repositoryPath;
  }
  return expanded;
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
  const homeDir = useHomeDir();
  const gitProbePaths = useMemo(
    () => uniqueWorkspaceProbePaths(workspaces),
    [workspaces],
  );
  // Key through the shared builder so `~` and absolute spellings collapse to
  // one cache entry and the chat-settled invalidation keys the same path. The
  // probe-path matching below runs against the raw `gitProbePaths`, so
  // expanding only the query key is safe. Home-relative probes wait for the
  // one-time home dir lookup — `get_git_state` does not expand `~`, so firing
  // before it resolves would issue a failing raw-`~` request under a key that
  // is immediately replaced by the expanded one (matching `useGitState`).
  const gitQueries = useQueries({
    queries: gitProbePaths.map((path) => {
      const queryKey = gitStateQueryKey(path, homeDir);
      return {
        queryKey,
        queryFn: () => getGitState(queryKey[1] ?? ""),
        enabled:
          enabled &&
          Boolean(path) &&
          (!isHomeRelativePath(path) || homeDir !== null),
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnWindowFocus: "always" as const,
      };
    }),
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
        // Derive classification/context against the expanded `~` spelling so it
        // lines up with `gitState`'s absolute paths, then restore the original
        // path so the returned workspace still matches session lookups by
        // path/id. The derivation preserves the original id already (only
        // `path` is expanded), so only `path` needs restoring.
        const derivationWorkspace = expandWorkspaceForGitDerivation(
          originalWorkspace,
          homeDir,
        );
        const derivedWorkspace = enrichWorkspaceAttachmentWithGitState(
          derivationWorkspace,
          gitState,
        );
        const gitContext = getWorkspaceGitContext(derivedWorkspace, gitState);
        const workspace =
          derivedWorkspace.path === originalWorkspace.path
            ? derivedWorkspace
            : { ...derivedWorkspace, path: originalWorkspace.path };

        return {
          workspace,
          comparableWorkspace: derivedWorkspace,
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
    [gitProbePaths, gitQueries, homeDir, workspaces],
  );
}

export function useWorkspaceChangedFilesRuntimes(
  workspaceRuntimes: WorkspaceGitRuntime[],
  enabled = true,
): WorkspaceChangedFilesRuntime[] {
  const homeDir = useHomeDir();
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
    queries: changeRoots.map(({ path }) => {
      const queryKey = changedFilesQueryKey(path, homeDir);
      return {
        queryKey,
        queryFn: () => getChangedFiles(queryKey[1] ?? ""),
        // Same home-dir gate as the git-state queries above: hold a
        // home-relative path until the home dir resolves so the expanded key
        // is the only one that fetches (matching `useChangedFiles`).
        enabled:
          enabled &&
          Boolean(path) &&
          (!isHomeRelativePath(path) || homeDir !== null),
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnWindowFocus: "always" as const,
      };
    }),
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
