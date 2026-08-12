import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRelativeWorkspacePath } from "@/features/chat/lib/workspaceAttachments";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import {
  useWorkspaceChangedFilesRuntimes,
  useWorkspaceGitRuntimes,
} from "./useWorkspaceGitRuntimes";

const mocks = vi.hoisted(() => ({
  homeDir: null as string | null,
  getGitState: vi.fn(),
  getChangedFiles: vi.fn(),
}));

vi.mock("@/shared/hooks/useHomeDir", () => ({
  useHomeDir: () => mocks.homeDir,
}));

vi.mock("@/shared/api/git", () => ({
  getGitState: (...args: unknown[]) => mocks.getGitState(...args),
  getChangedFiles: (...args: unknown[]) => mocks.getChangedFiles(...args),
}));

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

function homeRelativeWorkspace(): WorkspaceAttachment {
  return {
    id: "ws-1",
    path: "~/project",
    kind: "directory",
    source: "selected",
    usedByAgent: false,
  };
}

describe("useWorkspaceGitRuntimes", () => {
  beforeEach(() => {
    mocks.homeDir = null;
    mocks.getGitState.mockReset().mockResolvedValue({
      isGitRepo: false,
      currentBranch: null,
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [],
      isWorktree: false,
      mainWorktreePath: null,
      localBranches: [],
    });
    mocks.getChangedFiles.mockReset().mockResolvedValue([]);
  });

  it("holds a `~`-spelled probe until the home dir resolves, then queries only the expanded path", async () => {
    const queryClient = new QueryClient();
    const workspaces = [homeRelativeWorkspace()];

    const { rerender } = renderHook(() => useWorkspaceGitRuntimes(workspaces), {
      wrapper: createWrapper(queryClient),
    });

    // Home dir is still null: `get_git_state` does not expand `~`, so the raw
    // `~/project` key must not fetch.
    await Promise.resolve();
    expect(mocks.getGitState).not.toHaveBeenCalled();

    // Once the home dir is known, only the expanded absolute path is queried.
    mocks.homeDir = "/Users/test";
    rerender();

    await waitFor(() =>
      expect(mocks.getGitState).toHaveBeenCalledWith("/Users/test/project"),
    );
    expect(mocks.getGitState).not.toHaveBeenCalledWith("~/project");
  });

  it("classifies a `~`-spelled workspace git-backed and queries its expanded changed-file root", async () => {
    mocks.homeDir = "/Users/test";
    mocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "main",
      dirtyFileCount: 2,
      incomingCommitCount: 0,
      worktrees: [
        { path: "/Users/test/project", branch: "main", isMain: true },
      ],
      isWorktree: false,
      mainWorktreePath: "/Users/test/project",
      localBranches: ["main"],
    });
    mocks.getChangedFiles.mockResolvedValue([
      { path: "a.ts", status: "modified", additions: 1, deletions: 0 },
    ]);

    const queryClient = new QueryClient();
    const workspaces = [homeRelativeWorkspace()];

    const { result } = renderHook(
      () => {
        const gitRuntimes = useWorkspaceGitRuntimes(workspaces);
        const changedFiles = useWorkspaceChangedFilesRuntimes(gitRuntimes);
        return { gitRuntimes, changedFiles };
      },
      { wrapper: createWrapper(queryClient) },
    );

    // The workspace is git-backed and exposes git actions despite the `~`
    // spelling — the derivation runs against the expanded absolute path.
    await waitFor(() =>
      expect(result.current.gitRuntimes[0]?.gitContext.canUseGitActions).toBe(
        true,
      ),
    );
    expect(result.current.gitRuntimes[0]?.gitContext.isGitBacked).toBe(true);
    // The returned workspace keeps its original `~` spelling for session lookups.
    expect(result.current.gitRuntimes[0]?.workspace.path).toBe("~/project");

    // The changed-file root is not skipped and queries the expanded path.
    await waitFor(() =>
      expect(mocks.getChangedFiles).toHaveBeenCalledWith("/Users/test/project"),
    );
    expect(result.current.changedFiles).toHaveLength(1);
    expect(result.current.changedFiles[0]?.repoPath).toBe(
      "/Users/test/project",
    );
    expect(mocks.getChangedFiles).not.toHaveBeenCalledWith("~/project");
  });

  it("exposes an expanded comparable workspace so a `~`-spelled subdirectory keeps its suffix in worktree path math", async () => {
    mocks.homeDir = "/Users/test";
    mocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "main",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [
        { path: "/Users/test/project", branch: "main", isMain: true },
      ],
      isWorktree: false,
      mainWorktreePath: "/Users/test/project",
      localBranches: ["main"],
    });

    const queryClient = new QueryClient();
    const workspaces: WorkspaceAttachment[] = [
      {
        id: "ws-sub",
        path: "~/project/packages/app",
        kind: "directory",
        source: "selected",
        usedByAgent: false,
      },
    ];

    const { result } = renderHook(() => useWorkspaceGitRuntimes(workspaces), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() =>
      expect(result.current[0]?.gitContext.canUseGitActions).toBe(true),
    );
    const runtime = result.current[0];
    // The raw spelling stays on `workspace` for session lookups by path/id…
    expect(runtime?.workspace.path).toBe("~/project/packages/app");
    // …while `comparableWorkspace` carries the expanded spelling so the
    // ContextPanel worktree-select/create handlers can compare it against the
    // absolute `gitContext.worktreePath` without dropping the `/packages/app`
    // suffix on a worktree switch.
    expect(runtime?.comparableWorkspace.path).toBe(
      "/Users/test/project/packages/app",
    );
    expect(runtime?.gitContext.worktreePath).toBe("/Users/test/project");
    expect(
      getRelativeWorkspacePath(
        runtime?.comparableWorkspace.path ?? "",
        runtime?.gitContext.worktreePath,
      ),
    ).toBe("packages/app");
  });
});
