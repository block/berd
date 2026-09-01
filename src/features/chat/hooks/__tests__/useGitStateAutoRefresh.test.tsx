import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_GIT_AUTO_REFRESH_DELAY_MS,
  useGitStateAutoRefreshOnChatSettled,
} from "../useGitStateAutoRefresh";
import { useChatSessionStore } from "../../stores/chatSessionStore";
import { useChatStore } from "../../stores/chatStore";

vi.mock("@/shared/hooks/useHomeDir", () => ({
  useHomeDir: () => "/Users/test",
}));

function resetStores() {
  useChatStore.setState({
    messagesBySession: {},
    sessionStateById: {},
    queuedMessageBySession: {},
    draftsBySession: {},
    skillDraftsBySession: {},
    activeSessionId: null,
    recentMessageSessionIds: [],
    isViewingActiveSession: false,
    isConnected: false,
    loadingSessionIds: new Set(),
    scrollTargetMessageBySession: {},
  });

  useChatSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    isLoading: false,
    isLoadingMoreSessions: false,
    hasHydratedSessions: false,
    sessionPageCursor: null,
    hasMoreSessions: false,
    isRightRailOpen: false,
    activeWorkspaceBySession: {},
    archiveMutationBySessionId: {},
  });
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe("useGitStateAutoRefreshOnChatSettled", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStores();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("invalidates git queries for the current workspace after a chat settles", async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    useChatSessionStore.getState().setActiveWorkspace("session-1", {
      path: "/Users/test/project-worktree",
      branch: "feature",
    });
    useChatStore.getState().setChatState("session-1", "streaming");
    useChatStore.getState().setStreamingMessageId("session-1", "message-1");

    renderHook(
      () =>
        useGitStateAutoRefreshOnChatSettled({
          sessionId: "session-1",
          sessionWorkingDir: "/Users/test/project",
          projectWorkingDirs: ["/Users/test/project-default"],
        }),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      useChatStore.getState().setChatState("session-1", "idle");
      useChatStore.getState().setStreamingMessageId("session-1", null);
    });
    act(() => {
      vi.advanceTimersByTime(CHAT_GIT_AUTO_REFRESH_DELAY_MS);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["git-state", "/Users/test/project-worktree"],
      exact: true,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["changed-files", "/Users/test/project-worktree"],
      exact: true,
    });
  });

  it("expands ~ so the invalidation keys match the git-state observer keys", async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    useChatSessionStore.getState().setActiveWorkspace("session-1", {
      path: "~/project-worktree",
      branch: "feature",
    });
    useChatStore.getState().setChatState("session-1", "streaming");
    useChatStore.getState().setStreamingMessageId("session-1", "message-1");

    renderHook(
      () =>
        useGitStateAutoRefreshOnChatSettled({
          sessionId: "session-1",
        }),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      useChatStore.getState().setChatState("session-1", "idle");
      useChatStore.getState().setStreamingMessageId("session-1", null);
    });
    act(() => {
      vi.advanceTimersByTime(CHAT_GIT_AUTO_REFRESH_DELAY_MS);
    });

    // The observers (useGitState/useSidebarBranchSubtitles) key the expanded
    // path, so the invalidation must too — keying the raw `~` spelling would
    // miss them.
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["git-state", "/Users/test/project-worktree"],
      exact: true,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["changed-files", "/Users/test/project-worktree"],
      exact: true,
    });
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: ["git-state", "~/project-worktree"],
      exact: true,
    });
  });

  it("coalesces rapid settle/work/settle transitions", async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    useChatStore.getState().setChatState("session-1", "streaming");
    useChatStore.getState().setStreamingMessageId("session-1", "message-1");

    renderHook(
      () =>
        useGitStateAutoRefreshOnChatSettled({
          sessionId: "session-1",
          sessionWorkingDir: "/Users/test/project",
        }),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      useChatStore.getState().setChatState("session-1", "idle");
      useChatStore.getState().setStreamingMessageId("session-1", null);
    });
    act(() => {
      vi.advanceTimersByTime(CHAT_GIT_AUTO_REFRESH_DELAY_MS - 100);
    });
    act(() => {
      useChatStore.getState().setChatState("session-1", "streaming");
      useChatStore.getState().setStreamingMessageId("session-1", "message-2");
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(invalidateSpy).not.toHaveBeenCalled();

    act(() => {
      useChatStore.getState().setChatState("session-1", "idle");
      useChatStore.getState().setStreamingMessageId("session-1", null);
    });
    act(() => {
      vi.advanceTimersByTime(CHAT_GIT_AUTO_REFRESH_DELAY_MS);
    });

    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });

  it("never invalidates git queries for a remote session", () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Remote",
          workingDir: "/home/dev/project",
          remoteHost: "devbox",
          createdAt: "2026-08-27T00:00:00.000Z",
          updatedAt: "2026-08-27T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    useChatStore.getState().setChatState("session-1", "streaming");
    useChatStore.getState().setStreamingMessageId("session-1", "message-1");

    renderHook(
      () =>
        useGitStateAutoRefreshOnChatSettled({
          sessionId: "session-1",
          sessionWorkingDir: "/home/dev/project",
        }),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      useChatStore.getState().setChatState("session-1", "idle");
      useChatStore.getState().setStreamingMessageId("session-1", null);
    });
    act(() => {
      vi.advanceTimersByTime(CHAT_GIT_AUTO_REFRESH_DELAY_MS);
    });

    // The path names a directory on the SSH host; a local git-state refetch
    // would probe the wrong filesystem, so the settle must not schedule one.
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("does not refresh on initial idle render", () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    renderHook(
      () =>
        useGitStateAutoRefreshOnChatSettled({
          sessionId: "session-1",
          sessionWorkingDir: "/Users/test/project",
        }),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      vi.advanceTimersByTime(CHAT_GIT_AUTO_REFRESH_DELAY_MS);
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
