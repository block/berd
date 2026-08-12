import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import {
  cleanupSessionWorkspaces,
  countSessionWorkspaceCleanupResources,
  getSessionWorkspaceCleanupResourceKind,
  inspectSessionWorkspaceCleanup,
  loadAllSessionsForWorkspaceCleanup,
  planSessionWorkspaceCleanup,
  type SessionWorkspaceCleanupInterruptedError,
  wouldSessionWorkspaceCleanupDiscardFiles,
} from "../sessionWorkspaceCleanup";

const mocks = vi.hoisted(() => ({
  acpListSessionsPage: vi.fn(),
  countBranchCommitsNotInBase: vi.fn(),
  hasIgnoredFiles: vi.fn(),
  deleteBranch: vi.fn(),
  getGitState: vi.fn(),
  pathExists: vi.fn(),
  removeWorktree: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpListSessionsPage: mocks.acpListSessionsPage,
}));

vi.mock("@/shared/api/git", () => ({
  countBranchCommitsNotInBase: mocks.countBranchCommitsNotInBase,
  hasIgnoredFiles: mocks.hasIgnoredFiles,
  deleteBranch: mocks.deleteBranch,
  getGitState: mocks.getGitState,
  removeWorktree: mocks.removeWorktree,
}));

vi.mock("@/shared/api/system", () => ({
  pathExists: mocks.pathExists,
}));

function makeManagedWorktree(
  path = "/repo-worktrees/chat",
): WorkspaceAttachment {
  return {
    id: `path:${path}`,
    path,
    kind: "git-linked-worktree",
    source: "created",
    branch: "chat",
    repositoryPath: "/repo",
    worktreePath: path,
    usedByAgent: true,
    lifecycle: {
      owner: "goose",
      cleanup: "worktree",
      branch: "chat",
      baseBranch: "main",
      repositoryPath: "/repo",
      worktreePath: path,
      createdBranch: true,
    },
  };
}

function makeManagedBranch(): WorkspaceAttachment {
  return {
    id: "path:/repo",
    path: "/repo",
    kind: "git-main-worktree",
    source: "created",
    branch: "chat",
    repositoryPath: "/repo",
    worktreePath: "/repo",
    usedByAgent: true,
    lifecycle: {
      owner: "goose",
      cleanup: "branch",
      branch: "chat",
      baseBranch: "main",
      repositoryPath: "/repo",
      worktreePath: "/repo",
      createdBranch: true,
    },
  };
}

function makeSession(
  id: string,
  attachments: WorkspaceAttachment[],
  archivedAt?: string,
): ChatSession {
  return {
    id,
    title: id,
    workingDir: attachments[0]?.path ?? null,
    workspaceAttachments: attachments,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    archivedAt,
    messageCount: 1,
  };
}

describe("session workspace cleanup", () => {
  beforeEach(() => {
    mocks.acpListSessionsPage.mockReset().mockResolvedValue({
      sessions: [],
      nextCursor: null,
    });
    mocks.countBranchCommitsNotInBase.mockReset().mockResolvedValue(0);
    mocks.hasIgnoredFiles.mockReset().mockResolvedValue(false);
    mocks.deleteBranch.mockReset().mockResolvedValue(undefined);
    mocks.removeWorktree.mockReset().mockResolvedValue(undefined);
    mocks.pathExists.mockReset().mockResolvedValue(true);
    mocks.getGitState.mockReset().mockResolvedValue({
      isGitRepo: true,
      currentBranch: "chat",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [
        { path: "/repo", branch: "main", isMain: true },
        { path: "/repo-worktrees/chat", branch: "chat", isMain: false },
      ],
      isWorktree: true,
      mainWorktreePath: "/repo",
      localBranches: ["main", "chat"],
    });
  });

  it("loads every session page before shared-workspace planning", async () => {
    mocks.acpListSessionsPage
      .mockResolvedValueOnce({
        sessions: [
          {
            sessionId: "first",
            title: "First",
            updatedAt: "2026-07-10T00:00:00.000Z",
            createdAt: "2026-07-10T00:00:00.000Z",
            lastMessageAt: null,
            archivedAt: null,
            userSetName: false,
            messageCount: 1,
            subtitle: null,
            workingDir: null,
            projectId: null,
            providerId: null,
            modelId: null,
            personaId: null,
          },
        ],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        sessions: [
          {
            sessionId: "second",
            title: "Second",
            updatedAt: "2026-07-09T00:00:00.000Z",
            createdAt: "2026-07-09T00:00:00.000Z",
            lastMessageAt: null,
            archivedAt: null,
            userSetName: false,
            messageCount: 1,
            subtitle: null,
            workingDir: null,
            projectId: null,
            providerId: null,
            modelId: null,
            personaId: null,
          },
        ],
        nextCursor: null,
      });

    await expect(loadAllSessionsForWorkspaceCleanup()).resolves.toMatchObject([
      { id: "first" },
      { id: "second" },
    ]);
    expect(mocks.acpListSessionsPage).toHaveBeenNthCalledWith(1, {
      cursor: null,
    });
    expect(mocks.acpListSessionsPage).toHaveBeenNthCalledWith(2, {
      cursor: "page-2",
    });
  });

  it("plans only Goose-managed cleanup targets", () => {
    const managed = makeManagedWorktree();
    const selected: WorkspaceAttachment = {
      ...managed,
      id: "path:/other",
      path: "/other",
      worktreePath: "/other",
      source: "selected",
      lifecycle: undefined,
    };
    const session = makeSession("session", [managed, selected]);

    expect(planSessionWorkspaceCleanup(session, [session])).toEqual([
      expect.objectContaining({
        repositoryPath: "/repo",
        cleanupPath: "/repo-worktrees/chat",
      }),
    ]);
  });

  it("counts worktree cleanup without separately counting its branch", async () => {
    const session = makeSession("session", [
      makeManagedWorktree(),
      makeManagedBranch(),
    ]);
    const plans = await inspectSessionWorkspaceCleanup(
      planSessionWorkspaceCleanup(session, [session]),
    );

    expect(countSessionWorkspaceCleanupResources(plans)).toEqual({
      worktreeCount: 1,
      branchCount: 1,
    });
  });

  it("calls an orphaned branch a branch when its worktree is already gone", () => {
    const session = makeSession("session", [makeManagedWorktree()]);
    const [plan] = planSessionWorkspaceCleanup(session, [session]);
    if (!plan) throw new Error("Expected a cleanup plan");
    const inspected = {
      ...plan,
      uncommittedFileCount: 0,
      hasIgnoredFiles: false,
      branchCommitsNotInBase: 0,
      worktreeExists: false,
      branchExists: true,
    };

    expect(getSessionWorkspaceCleanupResourceKind(inspected)).toBe("branch");
  });

  it("deduplicates subdirectories in one chat into one cleanup target", async () => {
    const worktreePath = "/repo-worktrees/chat";
    const app = {
      ...makeManagedWorktree(worktreePath),
      id: `path:${worktreePath}/app`,
      path: `${worktreePath}/app`,
      kind: "subdirectory" as const,
    };
    const docs = {
      ...makeManagedWorktree(worktreePath),
      id: `path:${worktreePath}/docs`,
      path: `${worktreePath}/docs`,
      kind: "subdirectory" as const,
    };
    const session = makeSession("session", [app, docs]);
    const plans = planSessionWorkspaceCleanup(session, [session]);

    expect(plans).toHaveLength(1);
    const inspected = await inspectSessionWorkspaceCleanup(plans);
    await cleanupSessionWorkspaces(inspected);

    expect(mocks.removeWorktree).toHaveBeenCalledTimes(1);
    expect(mocks.removeWorktree).toHaveBeenCalledWith(
      "/repo",
      worktreePath,
      true,
    );
    expect(mocks.deleteBranch).toHaveBeenCalledTimes(1);
  });

  it("does not clean a target still used by another active session", () => {
    const managed = makeManagedWorktree();
    const session = makeSession("session", [managed]);
    const other = makeSession("other", [{ ...managed }]);

    expect(planSessionWorkspaceCleanup(session, [session, other])).toEqual([]);
  });

  it("does not clean a target a `~`-spelled attachment in another session still uses", () => {
    const managed: WorkspaceAttachment = {
      ...makeManagedBranch(),
      id: "path:/Users/test/repo",
      path: "/Users/test/repo",
      repositoryPath: "/Users/test/repo",
      worktreePath: "/Users/test/repo",
      lifecycle: {
        owner: "goose",
        cleanup: "branch",
        branch: "chat",
        baseBranch: "main",
        repositoryPath: "/Users/test/repo",
        worktreePath: "/Users/test/repo",
        createdBranch: true,
      },
    };
    const session = makeSession("session", [managed]);
    const other = makeSession("other", [
      {
        id: "path:~/repo",
        path: "~/repo",
        kind: "directory",
        source: "selected",
        branch: null,
        usedByAgent: false,
      },
    ]);

    // Without the home dir the raw spelling cannot match the absolute target.
    expect(planSessionWorkspaceCleanup(session, [session, other])).toHaveLength(
      1,
    );
    expect(
      planSessionWorkspaceCleanup(session, [session, other], "/Users/test"),
    ).toEqual([]);
  });

  it("does clean a target used only by an archived session", () => {
    const managed = makeManagedWorktree();
    const session = makeSession("session", [managed]);
    const archived = makeSession(
      "archived",
      [{ ...managed }],
      "2026-07-09T00:00:00.000Z",
    );

    expect(
      planSessionWorkspaceCleanup(session, [session, archived]),
    ).toHaveLength(1);
  });

  it("detects ignored files that worktree removal would delete", async () => {
    mocks.hasIgnoredFiles.mockResolvedValue(true);
    const session = makeSession("session", [makeManagedWorktree()]);

    const [inspected] = await inspectSessionWorkspaceCleanup(
      planSessionWorkspaceCleanup(session, [session]),
    );

    expect(inspected?.hasIgnoredFiles).toBe(true);
    expect(mocks.hasIgnoredFiles).toHaveBeenCalledWith("/repo-worktrees/chat");
  });

  it("reads fresh dirty state before cleanup", async () => {
    mocks.getGitState.mockResolvedValueOnce({
      isGitRepo: true,
      currentBranch: "chat",
      dirtyFileCount: 3,
      incomingCommitCount: 0,
      worktrees: [],
      isWorktree: true,
      mainWorktreePath: "/repo",
      localBranches: ["main", "chat"],
    });
    const session = makeSession("session", [makeManagedWorktree()]);
    const plans = planSessionWorkspaceCleanup(session, [session]);

    await expect(inspectSessionWorkspaceCleanup(plans)).resolves.toEqual([
      expect.objectContaining({
        uncommittedFileCount: 3,
        worktreeExists: true,
        branchExists: true,
      }),
    ]);
  });

  it("preserves a created branch with commits not in its base", async () => {
    mocks.countBranchCommitsNotInBase.mockResolvedValue(2);
    const session = makeSession("session", [makeManagedWorktree()]);
    const inspected = await inspectSessionWorkspaceCleanup(
      planSessionWorkspaceCleanup(session, [session]),
    );

    await cleanupSessionWorkspaces(inspected);

    expect(mocks.removeWorktree).toHaveBeenCalledWith(
      "/repo",
      "/repo-worktrees/chat",
      true,
    );
    expect(mocks.deleteBranch).not.toHaveBeenCalled();
  });

  it("does not treat local edits on a preserved branch as cleanup loss", async () => {
    mocks.countBranchCommitsNotInBase.mockResolvedValue(2);
    mocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "chat",
      dirtyFileCount: 3,
      incomingCommitCount: 0,
      worktrees: [{ path: "/repo", branch: "chat", isMain: true }],
      isWorktree: false,
      mainWorktreePath: "/repo",
      localBranches: ["main", "chat"],
    });
    const session = makeSession("session", [makeManagedBranch()]);
    const [inspected] = await inspectSessionWorkspaceCleanup(
      planSessionWorkspaceCleanup(session, [session]),
    );

    if (!inspected) throw new Error("Expected an inspected plan");
    expect(wouldSessionWorkspaceCleanupDiscardFiles(inspected)).toBe(false);
  });

  it("removes a worktree before deleting its created branch", async () => {
    const session = makeSession("session", [makeManagedWorktree()]);
    const inspected = await inspectSessionWorkspaceCleanup(
      planSessionWorkspaceCleanup(session, [session]),
    );

    await cleanupSessionWorkspaces(inspected);

    expect(mocks.removeWorktree).toHaveBeenCalledWith(
      "/repo",
      "/repo-worktrees/chat",
      true,
    );
    expect(mocks.deleteBranch).toHaveBeenCalledWith(
      "/repo",
      "chat",
      true,
      "main",
    );
    expect(mocks.removeWorktree.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteBranch.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it("checks for interruption before every destructive Git mutation", async () => {
    const second = makeManagedWorktree("/repo-worktrees/second");
    second.branch = "second";
    if (!second.lifecycle) throw new Error("Expected managed lifecycle");
    second.lifecycle.branch = "second";
    const first = makeSession("session", [
      makeManagedWorktree("/repo-worktrees/first"),
      second,
    ]);
    const inspected = await inspectSessionWorkspaceCleanup(
      planSessionWorkspaceCleanup(first, [first]),
    );
    let checks = 0;

    await expect(
      cleanupSessionWorkspaces(inspected, {
        getInterruptionReason: () => (++checks >= 2 ? "timed_out" : null),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SessionWorkspaceCleanupInterruptedError>>(
        {
          reason: "timed_out",
        },
      ),
    );

    expect(mocks.removeWorktree).toHaveBeenCalledTimes(1);
    expect(mocks.deleteBranch).not.toHaveBeenCalled();
  });

  it("detects dirty managed branches and deletes them from their checkout", async () => {
    mocks.getGitState.mockResolvedValueOnce({
      isGitRepo: true,
      currentBranch: "chat",
      dirtyFileCount: 2,
      incomingCommitCount: 0,
      worktrees: [{ path: "/repo", branch: "chat", isMain: true }],
      isWorktree: false,
      mainWorktreePath: "/repo",
      localBranches: ["main", "chat"],
    });
    const session = makeSession("session", [makeManagedBranch()]);
    const inspected = await inspectSessionWorkspaceCleanup(
      planSessionWorkspaceCleanup(session, [session]),
    );

    expect(inspected[0]?.uncommittedFileCount).toBe(2);
    await cleanupSessionWorkspaces(inspected);

    expect(mocks.removeWorktree).not.toHaveBeenCalled();
    expect(mocks.deleteBranch).toHaveBeenCalledWith(
      "/repo",
      "chat",
      true,
      "main",
    );
  });
});
