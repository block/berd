import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { getGitState } from "@/shared/api/git";
import { useHomeDir } from "@/shared/hooks/useHomeDir";
import { gitStateQueryKey } from "@/shared/lib/gitStateQueryKey";
import { isHomeRelativePath } from "@/shared/lib/homePath";
import type {
  ActiveWorkspace,
  ChatSession,
} from "@/features/chat/stores/chatSessionStore";

type ActiveWorkspaceBySession = Record<string, ActiveWorkspace>;

function nonEmptyTrimmed(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function getSessionBranchSubtitlePath(
  session: ChatSession,
  activeWorkspace: ActiveWorkspace | undefined,
): string | null {
  return (
    nonEmptyTrimmed(activeWorkspace?.path) ??
    nonEmptyTrimmed(session.workingDir)
  );
}

function getSessionBranchSubtitle(
  session: ChatSession,
  activeWorkspace: ActiveWorkspace | undefined,
  branchNameByPath: ReadonlyMap<string, string | null>,
): string | null {
  const path = getSessionBranchSubtitlePath(session, activeWorkspace);
  if (path && branchNameByPath.has(path)) {
    return nonEmptyTrimmed(branchNameByPath.get(path));
  }

  return nonEmptyTrimmed(activeWorkspace?.branch);
}

function getBranchSubtitlePaths(
  sessions: ChatSession[],
  activeWorkspaceBySession: ActiveWorkspaceBySession,
  enabled: boolean,
): string[] {
  if (!enabled) return [];

  const paths = new Set<string>();
  for (const session of sessions) {
    if (session.archivedAt) continue;
    const activeWorkspace = activeWorkspaceBySession[session.id];
    const path = getSessionBranchSubtitlePath(session, activeWorkspace);
    if (path) {
      paths.add(path);
    }
  }

  return Array.from(paths).sort();
}

export function useSidebarBranchSubtitles({
  sessions,
  activeWorkspaceBySession,
  enabled,
}: {
  sessions: ChatSession[];
  activeWorkspaceBySession: ActiveWorkspaceBySession | undefined;
  enabled: boolean;
}) {
  const workspaces = activeWorkspaceBySession ?? {};
  const homeDir = useHomeDir();
  const paths = useMemo(
    () => getBranchSubtitlePaths(sessions, workspaces, enabled),
    [enabled, sessions, workspaces],
  );
  // Key through the shared builder so both spellings of the same directory
  // share one cache entry (with `useGitState`) and one `get_git_state` call —
  // and so the chat-settled invalidation keys the same normalized path.
  // Home-relative paths wait for the one-time home dir lookup rather than
  // fetching under a key that would immediately be replaced.
  const branchQueries = useQueries({
    queries: paths.map((path) => {
      const queryKey = gitStateQueryKey(path, homeDir);
      return {
        queryKey,
        queryFn: () => getGitState(queryKey[1] ?? ""),
        enabled: !isHomeRelativePath(path) || homeDir !== null,
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnWindowFocus: "always" as const,
      };
    }),
  });

  const branchNameByPath = useMemo(() => {
    const next = new Map<string, string | null>();
    paths.forEach((path, index) => {
      const gitState = branchQueries[index]?.data;
      if (!gitState) return;
      next.set(
        path,
        gitState.isGitRepo ? nonEmptyTrimmed(gitState.currentBranch) : null,
      );
    });
    return next;
  }, [branchQueries, paths]);

  return useMemo(() => {
    if (!enabled) {
      return new Map<string, string>();
    }

    const next = new Map<string, string>();
    for (const session of sessions) {
      const branchName = getSessionBranchSubtitle(
        session,
        workspaces[session.id],
        branchNameByPath,
      );
      if (branchName) {
        next.set(session.id, branchName);
      }
    }
    return next;
  }, [branchNameByPath, enabled, sessions, workspaces]);
}
