import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useHomeDir } from "@/shared/hooks/useHomeDir";
import {
  changedFilesQueryKey,
  gitStateQueryKey,
} from "@/shared/lib/gitStateQueryKey";
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";
import { isRemoteSession } from "../lib/remoteSession";
import { isSessionRunning } from "../lib/sessionActivity";
import { useChatSessionStore } from "../stores/chatSessionStore";
import { useChatStore } from "../stores/chatStore";

export const CHAT_GIT_AUTO_REFRESH_DELAY_MS = 1000;

interface UseGitStateAutoRefreshOptions {
  sessionId: string | null | undefined;
  sessionWorkingDir?: string | null;
  projectWorkingDirs?: string[];
  enabled?: boolean;
}

function clearScheduledRefresh(timeoutRef: MutableRefObject<number | null>) {
  if (timeoutRef.current === null) return;
  window.clearTimeout(timeoutRef.current);
  timeoutRef.current = null;
}

/**
 * Keeps the chat context rail's git summary in sync with agent work without
 * polling. When a chat moves from active work back to settled, we invalidate
 * the cached git queries for its current workspace. The context panel stays
 * mounted while the rail is hidden, so its queries remain active observers and
 * refetch immediately — the panel is warm and current the moment it reopens.
 */
export function useGitStateAutoRefreshOnChatSettled({
  sessionId,
  sessionWorkingDir,
  projectWorkingDirs = [],
  enabled = true,
}: UseGitStateAutoRefreshOptions) {
  const queryClient = useQueryClient();
  const homeDir = useHomeDir();
  const projectDefaultWorkspaceRoot = projectWorkingDirs[0] ?? null;
  const activeWorkspacePath = useChatSessionStore((state) =>
    sessionId ? state.activeWorkspaceBySession[sessionId]?.path : undefined,
  );
  // A remote session's workspace paths live on its SSH host: the local git
  // Tauri commands behind these query keys would probe the wrong filesystem,
  // so never schedule an invalidation (which would trigger refetches) for one.
  const sessionIsRemote = useChatSessionStore((state) =>
    sessionId
      ? isRemoteSession(
          state.sessions.find((candidate) => candidate.id === sessionId),
        )
      : false,
  );
  const refreshEnabled = enabled && !sessionIsRemote;
  const runtime = useChatStore((state) =>
    sessionId ? state.sessionStateById[sessionId] : undefined,
  );

  const gitTargetPath =
    activeWorkspacePath ?? sessionWorkingDir ?? projectDefaultWorkspaceRoot;
  const chatRuntime = runtime ?? INITIAL_SESSION_CHAT_RUNTIME;
  const isWorking =
    isSessionRunning(chatRuntime.chatState) ||
    chatRuntime.activeRunId !== null ||
    chatRuntime.streamingMessageId !== null ||
    chatRuntime.isRunCancellationPending;

  const lastSessionIdRef = useRef<string | null>(sessionId ?? null);
  const wasWorkingRef = useRef(isWorking);
  const refreshTimeoutRef = useRef<number | null>(null);

  const scheduleRefresh = useCallback(
    (path: string) => {
      clearScheduledRefresh(refreshTimeoutRef);
      refreshTimeoutRef.current = window.setTimeout(() => {
        refreshTimeoutRef.current = null;
        // Expand `~` through the shared key builders so this invalidation
        // targets the exact keys the ContextPanel/sidebar observers subscribe
        // to; keying the raw spelling would drop it onto a key nothing observes.
        void Promise.all([
          queryClient
            .invalidateQueries({
              queryKey: gitStateQueryKey(path, homeDir),
              exact: true,
            })
            .catch(() => undefined),
          queryClient
            .invalidateQueries({
              queryKey: changedFilesQueryKey(path, homeDir),
              exact: true,
            })
            .catch(() => undefined),
        ]);
      }, CHAT_GIT_AUTO_REFRESH_DELAY_MS);
    },
    [queryClient, homeDir],
  );

  useEffect(() => {
    if (!refreshEnabled || !sessionId) {
      clearScheduledRefresh(refreshTimeoutRef);
      lastSessionIdRef.current = sessionId ?? null;
      wasWorkingRef.current = false;
      return;
    }

    if (lastSessionIdRef.current !== sessionId) {
      clearScheduledRefresh(refreshTimeoutRef);
      lastSessionIdRef.current = sessionId;
      wasWorkingRef.current = isWorking;
      return;
    }

    if (isWorking) {
      clearScheduledRefresh(refreshTimeoutRef);
      wasWorkingRef.current = true;
      return;
    }

    if (!wasWorkingRef.current) {
      return;
    }

    wasWorkingRef.current = false;
    if (gitTargetPath) {
      scheduleRefresh(gitTargetPath);
    }
  }, [refreshEnabled, gitTargetPath, isWorking, scheduleRefresh, sessionId]);

  useEffect(() => {
    return () => clearScheduledRefresh(refreshTimeoutRef);
  }, []);
}
