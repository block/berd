import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "@/features/projects/api/projects";
import {
  planProjectChatWorkspacesAsIs,
  planProjectChatWorkspaces,
  projectRequiresStartupWorkspaceName,
  rollbackProjectChatWorkspacePlan,
  summarizeProjectWorkspaceStartup,
} from "./projectChatWorkspaces";

const gitMocks = vi.hoisted(() => ({
  createBranch: vi.fn(),
  createWorktree: vi.fn(),
  deleteBranch: vi.fn(),
  getGitState: vi.fn(),
  pathExists: vi.fn(),
  removeWorktree: vi.fn(),
}));

vi.mock("@/shared/api/git", () => ({
  createBranch: gitMocks.createBranch,
  createWorktree: gitMocks.createWorktree,
  deleteBranch: gitMocks.deleteBranch,
  getGitState: gitMocks.getGitState,
  removeWorktree: gitMocks.removeWorktree,
}));

vi.mock("@/shared/api/system", () => ({
  pathExists: gitMocks.pathExists,
}));

function project(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "builderbot",
    path: "/tmp/projects/builderbot.md",
    name: "Builderbot",
    description: "",
    prompt: "",
    icon: "tabler:folder-code",
    color: "olive",
    projectWorkspaces: [],
    workingDirs: [],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
    artifact: null,
    ...overrides,
  };
}

function workspace(path: string, startupMode: "none" | "branch" | "worktree") {
  return {
    id: `path:${path}`,
    path,
    kind: "subdirectory" as const,
    source: "selected" as const,
    branch: "main",
    repositoryPath: "/repo",
    worktreePath: "/repo",
    usedByAgent: false,
    startupMode,
  };
}

describe("project chat workspaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitMocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "main",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [{ path: "/repo", branch: "main", isMain: true }],
      isWorktree: false,
      mainWorktreePath: "/repo",
      localBranches: ["main"],
    });
    gitMocks.createWorktree.mockResolvedValue({
      path: "/repo-worktrees/chat-123",
      branch: "chat-123",
    });
    gitMocks.createBranch.mockResolvedValue(undefined);
    gitMocks.deleteBranch.mockResolvedValue(undefined);
    gitMocks.pathExists.mockResolvedValue(false);
    gitMocks.removeWorktree.mockResolvedValue(undefined);
  });

  it("summarizes planned Git actions once per repository", () => {
    expect(
      summarizeProjectWorkspaceStartup([
        workspace("/repo/apps/one", "worktree"),
        workspace("/repo/apps/two", "worktree"),
        {
          ...workspace("/other-repo/apps/three", "branch"),
          repositoryPath: "/other-repo",
          worktreePath: "/other-repo",
        },
      ]),
    ).toEqual({ worktreeCount: 1, branchCount: 1, exact: true });
  });

  it("does not claim exact action counts without repository metadata", () => {
    expect(
      summarizeProjectWorkspaceStartup([
        {
          ...workspace("/repo/apps/one", "worktree"),
          repositoryPath: null,
          worktreePath: null,
        },
        {
          ...workspace("/repo/apps/two", "worktree"),
          repositoryPath: null,
          worktreePath: null,
        },
      ]).exact,
    ).toBe(false);
  });

  it("requires a startup name when any project workspace creates git state", () => {
    expect(
      projectRequiresStartupWorkspaceName(
        project({
          projectWorkspaces: [
            workspace("/repo/builderbot", "none"),
            workspace("/repo/bbsubscriber", "worktree"),
          ],
        }),
      ),
    ).toBe(true);
  });

  it("plans every project workspace as-is without creating git state", () => {
    const plan = planProjectChatWorkspacesAsIs(
      project({
        projectWorkspaces: [
          workspace("/repo/builderbot", "worktree"),
          workspace("/repo/bbsubscriber", "branch"),
        ],
        workingDirs: ["/repo/builderbot", "/repo/bbsubscriber"],
      }),
    );

    expect(gitMocks.getGitState).not.toHaveBeenCalled();
    expect(gitMocks.createWorktree).not.toHaveBeenCalled();
    expect(gitMocks.createBranch).not.toHaveBeenCalled();
    expect(plan?.workingDir).toBe("/repo/builderbot");
    expect(plan?.workspaceAttachments).toEqual([
      expect.objectContaining({
        path: "/repo/builderbot",
        source: "inferred",
        branch: "main",
      }),
      expect.objectContaining({
        path: "/repo/bbsubscriber",
        source: "inferred",
        branch: "main",
      }),
    ]);
  });

  it("creates one worktree per repo and attaches matching subdirectories", async () => {
    const plan = await planProjectChatWorkspaces(
      project({
        projectWorkspaces: [
          workspace("/repo/builderbot", "worktree"),
          workspace("/repo/bbsubscriber", "worktree"),
        ],
        workingDirs: ["/repo/builderbot", "/repo/bbsubscriber"],
      }),
      "chat-123",
    );

    expect(gitMocks.createWorktree).toHaveBeenCalledOnce();
    expect(gitMocks.createWorktree).toHaveBeenCalledWith(
      "/repo",
      "chat-123",
      "chat-123",
      true,
      "main",
    );
    expect(plan?.workingDir).toBe("/repo-worktrees/chat-123/builderbot");
    expect(plan?.workspaceAttachments).toEqual([
      expect.objectContaining({
        path: "/repo-worktrees/chat-123/builderbot",
        source: "created",
        branch: "chat-123",
        lifecycle: expect.objectContaining({
          owner: "goose",
          cleanup: "worktree",
          branch: "chat-123",
          baseBranch: "main",
          repositoryPath: "/repo",
          worktreePath: "/repo-worktrees/chat-123",
          createdBranch: true,
        }),
      }),
      expect.objectContaining({
        path: "/repo-worktrees/chat-123/bbsubscriber",
        source: "created",
        branch: "chat-123",
        lifecycle: expect.objectContaining({
          owner: "goose",
          cleanup: "worktree",
          branch: "chat-123",
          baseBranch: "main",
          repositoryPath: "/repo",
          worktreePath: "/repo-worktrees/chat-123",
          createdBranch: true,
        }),
      }),
    ]);
  });

  it("uses the repository root for worktree creation when the project workspace is a subdirectory", async () => {
    gitMocks.getGitState.mockImplementation(async () => ({
      isGitRepo: true,
      currentBranch: "main",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [],
      isWorktree: false,
      mainWorktreePath: null,
      localBranches: ["main"],
    }));

    const plan = await planProjectChatWorkspaces(
      project({
        projectWorkspaces: [workspace("/repo/builderbot", "worktree")],
        workingDirs: ["/repo/builderbot"],
      }),
      "chat-123",
    );

    expect(gitMocks.pathExists).toHaveBeenCalledWith(
      "/repo-worktrees/chat-123",
    );
    expect(gitMocks.createWorktree).toHaveBeenCalledWith(
      "/repo",
      "chat-123",
      "chat-123",
      true,
      "main",
    );
    expect(plan?.workspaceAttachments).toEqual([
      expect.objectContaining({
        path: "/repo-worktrees/chat-123/builderbot",
        repositoryPath: "/repo",
        worktreePath: "/repo-worktrees/chat-123",
      }),
    ]);
  });

  it("skips stale repository metadata before creating a worktree", async () => {
    gitMocks.getGitState.mockImplementation(async (path: string) => {
      if (path === "/stale-repo") {
        return {
          isGitRepo: false,
          currentBranch: null,
          dirtyFileCount: 0,
          incomingCommitCount: 0,
          worktrees: [],
          isWorktree: false,
          mainWorktreePath: null,
          localBranches: [],
        };
      }

      return {
        isGitRepo: true,
        currentBranch: "main",
        dirtyFileCount: 0,
        incomingCommitCount: 0,
        worktrees: [],
        isWorktree: false,
        mainWorktreePath: null,
        localBranches: ["main"],
      };
    });

    const plan = await planProjectChatWorkspaces(
      project({
        projectWorkspaces: [
          {
            ...workspace("/repo/builderbot", "worktree"),
            repositoryPath: "/stale-repo",
          },
        ],
        workingDirs: ["/repo/builderbot"],
      }),
      "chat-123",
    );

    expect(gitMocks.createWorktree).not.toHaveBeenCalledWith(
      "/stale-repo",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(gitMocks.createWorktree).toHaveBeenCalledWith(
      "/repo",
      "chat-123",
      "chat-123",
      true,
      "main",
    );
    expect(plan?.workspaceAttachments).toEqual([
      expect.objectContaining({
        repositoryPath: "/repo",
        lifecycle: expect.objectContaining({
          repositoryPath: "/repo",
        }),
      }),
    ]);
  });

  it("uses persisted repository metadata when the selected subdirectory cannot be queried", async () => {
    gitMocks.getGitState.mockImplementation(async (path: string) => {
      if (path === "/repo/builderbot") {
        throw new Error("Path does not exist: /repo/builderbot");
      }

      return {
        isGitRepo: true,
        currentBranch: "main",
        dirtyFileCount: 0,
        incomingCommitCount: 0,
        worktrees: [{ path: "/repo", branch: "main", isMain: true }],
        isWorktree: false,
        mainWorktreePath: "/repo",
        localBranches: ["main"],
      };
    });

    await planProjectChatWorkspaces(
      project({
        projectWorkspaces: [workspace("/repo/builderbot", "worktree")],
        workingDirs: ["/repo/builderbot"],
      }),
      "chat-123",
    );

    expect(gitMocks.createWorktree).toHaveBeenCalledWith(
      "/repo",
      "chat-123",
      "chat-123",
      true,
      "main",
    );
  });

  it("attaches use-as-is workspaces alongside generated worktree workspaces", async () => {
    const plan = await planProjectChatWorkspaces(
      project({
        projectWorkspaces: [
          workspace("/repo/docs", "none"),
          workspace("/repo/builderbot", "worktree"),
          workspace("/repo/bbsubscriber", "worktree"),
        ],
        workingDirs: ["/repo/docs", "/repo/builderbot", "/repo/bbsubscriber"],
      }),
      "chat-123",
    );

    expect(gitMocks.createWorktree).toHaveBeenCalledOnce();
    expect(plan?.workspaceAttachments).toEqual([
      expect.objectContaining({
        path: "/repo/docs",
        source: "inferred",
        branch: "main",
      }),
      expect.objectContaining({
        path: "/repo-worktrees/chat-123/builderbot",
        source: "created",
        branch: "chat-123",
        lifecycle: expect.objectContaining({
          cleanup: "worktree",
          worktreePath: "/repo-worktrees/chat-123",
        }),
      }),
      expect.objectContaining({
        path: "/repo-worktrees/chat-123/bbsubscriber",
        source: "created",
        branch: "chat-123",
        lifecycle: expect.objectContaining({
          cleanup: "worktree",
          worktreePath: "/repo-worktrees/chat-123",
        }),
      }),
    ]);
  });

  it("creates one branch per repo and keeps the original workspace paths", async () => {
    const plan = await planProjectChatWorkspaces(
      project({
        projectWorkspaces: [
          workspace("/repo/builderbot", "branch"),
          workspace("/repo/bbsubscriber", "branch"),
        ],
        workingDirs: ["/repo/builderbot", "/repo/bbsubscriber"],
      }),
      "chat-123",
    );

    expect(gitMocks.createBranch).toHaveBeenCalledOnce();
    expect(gitMocks.createBranch).toHaveBeenCalledWith(
      "/repo",
      "chat-123",
      "main",
    );
    expect(plan?.workspaceAttachments).toEqual([
      expect.objectContaining({
        path: "/repo/builderbot",
        source: "created",
        branch: "chat-123",
        lifecycle: expect.objectContaining({
          owner: "goose",
          cleanup: "branch",
          branch: "chat-123",
          baseBranch: "main",
          repositoryPath: "/repo",
          worktreePath: "/repo",
          createdBranch: true,
        }),
      }),
      expect.objectContaining({
        path: "/repo/bbsubscriber",
        source: "created",
        branch: "chat-123",
        lifecycle: expect.objectContaining({
          owner: "goose",
          cleanup: "branch",
          branch: "chat-123",
          baseBranch: "main",
          repositoryPath: "/repo",
          worktreePath: "/repo",
          createdBranch: true,
        }),
      }),
    ]);
  });

  it("creates branch startup in the linked worktree checkout for linked-worktree workspaces", async () => {
    gitMocks.getGitState.mockImplementation(async (path: string) => ({
      isGitRepo: true,
      currentBranch: path.startsWith("/repo-linked") ? "feature" : "main",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [
        { path: "/repo", branch: "main", isMain: true },
        { path: "/repo-linked", branch: "feature", isMain: false },
      ],
      isWorktree: path.startsWith("/repo-linked"),
      mainWorktreePath: "/repo",
      localBranches: ["main", "feature"],
    }));

    const plan = await planProjectChatWorkspaces(
      project({
        projectWorkspaces: [
          {
            ...workspace("/repo-linked/builderbot", "branch"),
            repositoryPath: "/repo",
            worktreePath: "/repo-linked",
            branch: "feature",
          },
        ],
        workingDirs: ["/repo-linked/builderbot"],
      }),
      "chat-123",
    );

    expect(gitMocks.createBranch).toHaveBeenCalledOnce();
    expect(gitMocks.createBranch).toHaveBeenCalledWith(
      "/repo-linked",
      "chat-123",
      "feature",
    );
    expect(plan?.workspaceAttachments).toEqual([
      expect.objectContaining({
        path: "/repo-linked/builderbot",
        source: "created",
        branch: "chat-123",
        repositoryPath: "/repo",
        worktreePath: "/repo-linked",
        lifecycle: expect.objectContaining({
          cleanup: "branch",
          repositoryPath: "/repo",
          worktreePath: "/repo-linked",
          baseBranch: "feature",
        }),
      }),
    ]);
  });

  it("uses HEAD as the startup base for detached checkouts", async () => {
    gitMocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: null,
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [{ path: "/repo", branch: null, isMain: true }],
      isWorktree: false,
      mainWorktreePath: "/repo",
      localBranches: ["main", "release"],
    });

    await planProjectChatWorkspaces(
      project({
        projectWorkspaces: [workspace("/repo/builderbot", "worktree")],
        workingDirs: ["/repo/builderbot"],
      }),
      "chat-123",
    );

    expect(gitMocks.createWorktree).toHaveBeenCalledWith(
      "/repo",
      "chat-123",
      "chat-123",
      true,
      "HEAD",
    );
  });

  it("creates worktree startup from the linked worktree checkout branch", async () => {
    gitMocks.getGitState.mockImplementation(async (path: string) => ({
      isGitRepo: true,
      currentBranch: path.startsWith("/repo-linked") ? "feature" : "main",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [
        { path: "/repo", branch: "main", isMain: true },
        { path: "/repo-linked", branch: "feature", isMain: false },
      ],
      isWorktree: path.startsWith("/repo-linked"),
      mainWorktreePath: "/repo",
      localBranches: ["main", "feature"],
    }));

    const plan = await planProjectChatWorkspaces(
      project({
        projectWorkspaces: [
          {
            ...workspace("/repo-linked/builderbot", "worktree"),
            repositoryPath: "/repo",
            worktreePath: "/repo-linked",
            branch: "feature",
          },
        ],
        workingDirs: ["/repo-linked/builderbot"],
      }),
      "chat-123",
    );

    expect(gitMocks.createWorktree).toHaveBeenCalledOnce();
    expect(gitMocks.createWorktree).toHaveBeenCalledWith(
      "/repo-linked",
      "chat-123",
      "chat-123",
      true,
      "feature",
    );
    expect(plan?.workspaceAttachments).toEqual([
      expect.objectContaining({
        path: "/repo-worktrees/chat-123/builderbot",
        source: "created",
        branch: "chat-123",
        repositoryPath: "/repo",
        worktreePath: "/repo-worktrees/chat-123",
        lifecycle: expect.objectContaining({
          cleanup: "worktree",
          repositoryPath: "/repo",
          worktreePath: "/repo-worktrees/chat-123",
          baseBranch: "feature",
        }),
      }),
    ]);
  });

  it("rejects branch startup across multiple worktrees in the same repo before mutating git", async () => {
    gitMocks.getGitState.mockImplementation(async (path: string) => ({
      isGitRepo: true,
      currentBranch: path.startsWith("/repo-linked") ? "feature" : "main",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [
        { path: "/repo", branch: "main", isMain: true },
        { path: "/repo-linked", branch: "feature", isMain: false },
      ],
      isWorktree: path.startsWith("/repo-linked"),
      mainWorktreePath: "/repo",
      localBranches: ["main", "feature"],
    }));

    await expect(
      planProjectChatWorkspaces(
        project({
          projectWorkspaces: [
            workspace("/repo/builderbot", "branch"),
            {
              ...workspace("/repo-linked/bbsubscriber", "branch"),
              repositoryPath: "/repo",
              worktreePath: "/repo-linked",
            },
          ],
          workingDirs: ["/repo/builderbot", "/repo-linked/bbsubscriber"],
        }),
        "chat-123",
      ),
    ).rejects.toThrow(
      "Project workspaces in the same repository can create a branch only when they share a checkout.",
    );

    expect(gitMocks.createWorktree).not.toHaveBeenCalled();
    expect(gitMocks.createBranch).not.toHaveBeenCalled();
  });

  it("rejects mixed branch and worktree startup modes for the same repo before mutating git", async () => {
    await expect(
      planProjectChatWorkspaces(
        project({
          projectWorkspaces: [
            workspace("/repo/builderbot", "worktree"),
            workspace("/repo/bbsubscriber", "branch"),
          ],
          workingDirs: ["/repo/builderbot", "/repo/bbsubscriber"],
        }),
        "chat-123",
      ),
    ).rejects.toThrow(
      "Project workspaces in the same repository must use the same startup option.",
    );

    expect(gitMocks.createWorktree).not.toHaveBeenCalled();
    expect(gitMocks.createBranch).not.toHaveBeenCalled();
  });

  it("turns raw git worktree failures into plain English", async () => {
    gitMocks.createWorktree.mockRejectedValueOnce(
      new Error(
        "git worktree add -b test test /Users/test/repo-worktrees/test failed: fatal: not a valid branch name",
      ),
    );

    await expect(
      planProjectChatWorkspaces(
        project({
          projectWorkspaces: [workspace("/repo/builderbot", "worktree")],
          workingDirs: ["/repo/builderbot"],
        }),
        "test test",
      ),
    ).rejects.toThrow(
      "That name can’t be used for a worktree. Use letters, numbers, hyphens, or underscores.",
    );
  });

  it("rejects configured startup for non-git workspaces before mutating git", async () => {
    gitMocks.getGitState.mockResolvedValue({
      isGitRepo: false,
      currentBranch: null,
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [],
      isWorktree: false,
      mainWorktreePath: null,
      localBranches: [],
    });

    await expect(
      planProjectChatWorkspaces(
        project({
          projectWorkspaces: [workspace("/not-a-repo/builderbot", "branch")],
          workingDirs: ["/not-a-repo/builderbot"],
        }),
        "chat-123",
      ),
    ).rejects.toThrow(
      "Project workspace startup requires a Git repository, but /not-a-repo/builderbot is not inside one.",
    );

    expect(gitMocks.createWorktree).not.toHaveBeenCalled();
    expect(gitMocks.createBranch).not.toHaveBeenCalled();
  });

  it("rejects existing target branches across all repos before mutating git", async () => {
    gitMocks.getGitState.mockImplementation(async (path: string) => {
      const isOtherRepo = path.startsWith("/other-repo");
      const repoPath = isOtherRepo ? "/other-repo" : "/repo";
      return {
        isGitRepo: true,
        currentBranch: "main",
        dirtyFileCount: 0,
        incomingCommitCount: 0,
        worktrees: [{ path: repoPath, branch: "main", isMain: true }],
        isWorktree: false,
        mainWorktreePath: repoPath,
        localBranches: isOtherRepo ? ["main", "chat-123"] : ["main"],
      };
    });

    await expect(
      planProjectChatWorkspaces(
        project({
          projectWorkspaces: [
            workspace("/repo/builderbot", "worktree"),
            {
              ...workspace("/other-repo/bbsubscriber", "worktree"),
              repositoryPath: "/other-repo",
              worktreePath: "/other-repo",
            },
          ],
          workingDirs: ["/repo/builderbot", "/other-repo/bbsubscriber"],
        }),
        "chat-123",
      ),
    ).rejects.toThrow(
      'A branch named "chat-123" already exists for /other-repo/bbsubscriber. Choose a different name.',
    );

    expect(gitMocks.createWorktree).not.toHaveBeenCalled();
    expect(gitMocks.createBranch).not.toHaveBeenCalled();
  });

  it("rejects existing target worktree paths across all repos before mutating git", async () => {
    gitMocks.getGitState.mockImplementation(async (path: string) => {
      const isOtherRepo = path.startsWith("/other-repo");
      const repoPath = isOtherRepo ? "/other-repo" : "/repo";
      return {
        isGitRepo: true,
        currentBranch: "main",
        dirtyFileCount: 0,
        incomingCommitCount: 0,
        worktrees: [{ path: repoPath, branch: "main", isMain: true }],
        isWorktree: false,
        mainWorktreePath: repoPath,
        localBranches: ["main"],
      };
    });
    gitMocks.pathExists.mockImplementation(
      async (path: string) => path === "/other-repo-worktrees/chat-123",
    );

    await expect(
      planProjectChatWorkspaces(
        project({
          projectWorkspaces: [
            workspace("/repo/builderbot", "worktree"),
            {
              ...workspace("/other-repo/bbsubscriber", "worktree"),
              repositoryPath: "/other-repo",
              worktreePath: "/other-repo",
            },
          ],
          workingDirs: ["/repo/builderbot", "/other-repo/bbsubscriber"],
        }),
        "chat-123",
      ),
    ).rejects.toThrow(
      "A worktree already exists at /other-repo-worktrees/chat-123 for /other-repo/bbsubscriber. Choose a different name.",
    );

    expect(gitMocks.createWorktree).not.toHaveBeenCalled();
    expect(gitMocks.createBranch).not.toHaveBeenCalled();
  });

  it("rolls back created branches when a later project workspace branch fails", async () => {
    gitMocks.getGitState.mockImplementation(async (path: string) => {
      const isOtherRepo = path.startsWith("/other-repo");
      const repoPath = isOtherRepo ? "/other-repo" : "/repo";
      return {
        isGitRepo: true,
        currentBranch: "main",
        dirtyFileCount: 0,
        incomingCommitCount: 0,
        worktrees: [{ path: repoPath, branch: "main", isMain: true }],
        isWorktree: false,
        mainWorktreePath: repoPath,
        localBranches: ["main"],
      };
    });
    gitMocks.createBranch.mockImplementation(async (path: string) => {
      if (path === "/other-repo") {
        throw new Error("git lock");
      }
    });

    await expect(
      planProjectChatWorkspaces(
        project({
          projectWorkspaces: [
            workspace("/repo/builderbot", "branch"),
            {
              ...workspace("/other-repo/bbsubscriber", "branch"),
              repositoryPath: "/other-repo",
              worktreePath: "/other-repo",
            },
          ],
          workingDirs: ["/repo/builderbot", "/other-repo/bbsubscriber"],
        }),
        "chat-123",
      ),
    ).rejects.toThrow(
      "Berd couldn’t prepare the project workspace. Try again.",
    );

    expect(gitMocks.deleteBranch).toHaveBeenCalledWith(
      "/repo",
      "chat-123",
      false,
      "main",
    );
    expect(gitMocks.removeWorktree).not.toHaveBeenCalled();
  });

  it("rolls back created worktrees when a later project workspace worktree fails", async () => {
    gitMocks.getGitState.mockImplementation(async (path: string) => {
      const isOtherRepo = path.startsWith("/other-repo");
      const repoPath = isOtherRepo ? "/other-repo" : "/repo";
      return {
        isGitRepo: true,
        currentBranch: "main",
        dirtyFileCount: 0,
        incomingCommitCount: 0,
        worktrees: [{ path: repoPath, branch: "main", isMain: true }],
        isWorktree: false,
        mainWorktreePath: repoPath,
        localBranches: ["main"],
      };
    });
    gitMocks.createWorktree.mockImplementation(async (path: string) => {
      if (path === "/other-repo") {
        throw new Error("worktree locked");
      }
      return {
        path: "/repo-worktrees/chat-123",
        branch: "chat-123",
      };
    });

    await expect(
      planProjectChatWorkspaces(
        project({
          projectWorkspaces: [
            workspace("/repo/builderbot", "worktree"),
            {
              ...workspace("/other-repo/bbsubscriber", "worktree"),
              repositoryPath: "/other-repo",
              worktreePath: "/other-repo",
            },
          ],
          workingDirs: ["/repo/builderbot", "/other-repo/bbsubscriber"],
        }),
        "chat-123",
      ),
    ).rejects.toThrow(
      "Berd couldn’t prepare the project workspace. Try again.",
    );

    expect(gitMocks.removeWorktree).toHaveBeenCalledWith(
      "/repo",
      "/repo-worktrees/chat-123",
      false,
    );
    expect(gitMocks.deleteBranch).toHaveBeenCalledWith(
      "/repo",
      "chat-123",
      false,
      "main",
    );
  });

  it("rolls back a completed worktree plan from lifecycle metadata", async () => {
    const plan = await planProjectChatWorkspaces(
      project({
        projectWorkspaces: [
          workspace("/repo/builderbot", "worktree"),
          workspace("/repo/bbsubscriber", "worktree"),
        ],
        workingDirs: ["/repo/builderbot", "/repo/bbsubscriber"],
      }),
      "chat-123",
    );
    gitMocks.removeWorktree.mockClear();
    gitMocks.deleteBranch.mockClear();

    await rollbackProjectChatWorkspacePlan(plan);

    expect(gitMocks.removeWorktree).toHaveBeenCalledOnce();
    expect(gitMocks.removeWorktree).toHaveBeenCalledWith(
      "/repo",
      "/repo-worktrees/chat-123",
      false,
    );
    expect(gitMocks.deleteBranch).toHaveBeenCalledOnce();
    expect(gitMocks.deleteBranch).toHaveBeenCalledWith(
      "/repo",
      "chat-123",
      false,
      "main",
    );
  });

  it("rolls back a completed branch plan from lifecycle metadata", async () => {
    const plan = await planProjectChatWorkspaces(
      project({
        projectWorkspaces: [workspace("/repo/builderbot", "branch")],
        workingDirs: ["/repo/builderbot"],
      }),
      "chat-123",
    );
    gitMocks.deleteBranch.mockClear();

    await rollbackProjectChatWorkspacePlan(plan);

    expect(gitMocks.removeWorktree).not.toHaveBeenCalled();
    expect(gitMocks.deleteBranch).toHaveBeenCalledOnce();
    expect(gitMocks.deleteBranch).toHaveBeenCalledWith(
      "/repo",
      "chat-123",
      false,
      "main",
    );
  });

  it("reports non-forceful rollback failures instead of deleting concurrent edits", async () => {
    const plan = await planProjectChatWorkspaces(
      project({
        projectWorkspaces: [workspace("/repo/builderbot", "worktree")],
        workingDirs: ["/repo/builderbot"],
      }),
      "chat-123",
    );
    gitMocks.removeWorktree.mockRejectedValueOnce(
      new Error("worktree contains modified or untracked files"),
    );

    await expect(rollbackProjectChatWorkspacePlan(plan)).rejects.toThrow(
      "Workspace startup rollback failed: remove worktree /repo-worktrees/chat-123: worktree contains modified or untracked files",
    );
    expect(gitMocks.removeWorktree).toHaveBeenCalledWith(
      "/repo",
      "/repo-worktrees/chat-123",
      false,
    );
  });

  it.each([
    {
      startupName: "feature/chat-123",
      error:
        'Worktree startup names cannot include "/" or "\\". Choose a name without path separators.',
    },
    {
      startupName: "feature\\chat-123",
      error:
        'Worktree startup names cannot include "/" or "\\". Choose a name without path separators.',
    },
    {
      startupName: ".",
      error:
        "Worktree startup names must be real folder names. Choose a different name.",
    },
    {
      startupName: "..",
      error:
        "Worktree startup names must be real folder names. Choose a different name.",
    },
  ])("rejects invalid worktree startup name $startupName before mutating git", async ({
    startupName,
    error,
  }) => {
    await expect(
      planProjectChatWorkspaces(
        project({
          projectWorkspaces: [
            workspace("/repo/builderbot", "branch"),
            {
              ...workspace("/other-repo/bbsubscriber", "worktree"),
              repositoryPath: "/other-repo",
              worktreePath: "/other-repo",
            },
          ],
          workingDirs: ["/repo/builderbot", "/other-repo/bbsubscriber"],
        }),
        startupName,
      ),
    ).rejects.toThrow(error);

    expect(gitMocks.getGitState).not.toHaveBeenCalled();
    expect(gitMocks.createWorktree).not.toHaveBeenCalled();
    expect(gitMocks.createBranch).not.toHaveBeenCalled();
  });
});
