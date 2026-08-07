import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listenGitStateChanged,
  type GitStateChangedPayload,
} from "@/shared/api/git";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { GitStateEvents } from "./GitStateEvents";

vi.mock("@/shared/api/git", () => ({
  listenGitStateChanged: vi.fn(),
}));

const listenGitStateChangedMock = vi.mocked(listenGitStateChanged);
let gitStateChangedHandler:
  | ((payload: GitStateChangedPayload) => void)
  | undefined;

function resetSessionStore() {
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

describe("GitStateEvents", () => {
  beforeEach(() => {
    resetSessionStore();
    gitStateChangedHandler = undefined;
    listenGitStateChangedMock.mockReset();
    listenGitStateChangedMock.mockImplementation((handler) => {
      gitStateChangedHandler = handler;
      return Promise.resolve(vi.fn());
    });
  });

  it("invalidates git state and changed files when backend git state changes", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    render(
      <QueryClientProvider client={queryClient}>
        <GitStateEvents />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(gitStateChangedHandler).toBeDefined();
    });

    gitStateChangedHandler?.({
      operation: "switch_branch",
      path: "/Users/test/project",
      affectedPaths: [],
      branch: "feature",
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["git-state"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["changed-files"],
    });
  });

  it("does not mutate active workspaces from global git events", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Worktree chat",
          workingDir: "/Users/test/project",
          createdAt: "2026-07-08T00:00:00.000Z",
          updatedAt: "2026-07-08T00:00:00.000Z",
          messageCount: 1,
        },
        {
          id: "session-2",
          title: "Other chat",
          workingDir: "/Users/test/other",
          createdAt: "2026-07-08T00:00:00.000Z",
          updatedAt: "2026-07-08T00:00:00.000Z",
          messageCount: 1,
        },
      ],
      activeWorkspaceBySession: {
        "session-1": {
          path: "/Users/test/project",
          branch: "main",
        },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <GitStateEvents />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(gitStateChangedHandler).toBeDefined();
    });

    gitStateChangedHandler?.({
      operation: "create_worktree",
      path: "/Users/test/project",
      affectedPaths: ["/Users/test/project-worktrees/feature"],
      branch: "feature",
    });

    expect(
      useChatSessionStore.getState().activeWorkspaceBySession["session-1"],
    ).toEqual({
      path: "/Users/test/project",
      branch: "main",
    });
    expect(
      useChatSessionStore.getState().activeWorkspaceBySession["session-2"],
    ).toBeUndefined();
  });
});
