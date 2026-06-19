import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";
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
 * the cached git queries for its current workspace. Active right-rail queries
 * refetch immediately; closed panels are only marked stale and refresh on the
 * next open.
 */
export function useGitStateAutoRefreshOnChatSettled({
  sessionId,
  sessionWorkingDir,
  projectWorkingDirs = [],
  enabled = true,
}: UseGitStateAutoRefreshOptions) {
  const queryClient = useQueryClient();
  const projectDefaultWorkspaceRoot = projectWorkingDirs[0] ?? null;
  const activeWorkspacePath = useChatSessionStore((state) =>
    sessionId ? state.activeWorkspaceBySession[sessionId]?.path : undefined,
  );
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
        void Promise.all([
          queryClient
            .invalidateQueries({
              queryKey: ["git-state", path],
              exact: true,
            })
            .catch(() => undefined),
          queryClient
            .invalidateQueries({
              queryKey: ["changed-files", path],
              exact: true,
            })
            .catch(() => undefined),
        ]);
      }, CHAT_GIT_AUTO_REFRESH_DELAY_MS);
    },
    [queryClient],
  );

  useEffect(() => {
    if (!enabled || !sessionId) {
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
  }, [enabled, gitTargetPath, isWorking, scheduleRefresh, sessionId]);

  useEffect(() => {
    return () => clearScheduledRefresh(refreshTimeoutRef);
  }, []);
}
