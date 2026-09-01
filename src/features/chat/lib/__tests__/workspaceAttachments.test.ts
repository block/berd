import { describe, expect, it } from "vitest";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import type { GitState } from "@/shared/types/git";
import {
  classifyWorkspaceAttachment,
  enrichWorkspaceAttachmentWithGitState,
  ensureWorkspaceAttachment,
  formatIncludedWorkspacesPrompt,
  getWorkspaceCleanupTarget,
  getIncludedWorkspaceAttachments,
  getWorkspaceAttachments,
  getWorkspaceTitle,
  isSameWorkspacePathWithHome,
  removeWorkspaceAttachment,
  workspaceAttachmentUsesCleanupTarget,
  workspaceAttachmentIdForPath,
  withWorkspaceBackfill,
} from "../workspaceAttachments";

const gitState: GitState = {
  isGitRepo: true,
  currentBranch: "feature/chat-workspaces",
  dirtyFileCount: 0,
  incomingCommitCount: 0,
  worktrees: [
    {
      path: "/Users/test/goose",
      branch: "main",
      isMain: true,
    },
    {
      path: "/Users/test/goose-worktrees/chat-workspaces",
      branch: "feature/chat-workspaces",
      isMain: false,
    },
  ],
  isWorktree: true,
  mainWorktreePath: "/Users/test/goose",
  localBranches: ["main", "feature/chat-workspaces"],
};

function attachment(
  path: string,
  overrides: Partial<WorkspaceAttachment> = {},
): WorkspaceAttachment {
  return {
    id: workspaceAttachmentIdForPath(path),
    path,
    kind: "directory",
    source: "inferred",
    branch: null,
    usedByAgent: false,
    ...overrides,
  };
}

describe("classifyWorkspaceAttachment", () => {
  it("classifies a main worktree root", () => {
    expect(classifyWorkspaceAttachment("/Users/test/goose", gitState)).toEqual({
      kind: "git-main-worktree",
      branch: "main",
      repositoryPath: "/Users/test/goose",
      worktreePath: "/Users/test/goose",
    });
  });

  it("classifies a linked worktree root", () => {
    expect(
      classifyWorkspaceAttachment(
        "/Users/test/goose-worktrees/chat-workspaces",
        gitState,
      ),
    ).toEqual({
      kind: "git-linked-worktree",
      branch: "feature/chat-workspaces",
      repositoryPath: "/Users/test/goose",
      worktreePath: "/Users/test/goose-worktrees/chat-workspaces",
    });
  });

  it("classifies a subdirectory inside a worktree", () => {
    expect(
      classifyWorkspaceAttachment(
        "/Users/test/goose-worktrees/chat-workspaces/src/features/chat",
        gitState,
      ),
    ).toEqual({
      kind: "subdirectory",
      branch: "feature/chat-workspaces",
      repositoryPath: "/Users/test/goose",
      worktreePath: "/Users/test/goose-worktrees/chat-workspaces",
    });
  });

  it("classifies a non-git directory", () => {
    expect(
      classifyWorkspaceAttachment("/Users/test/notes", {
        isGitRepo: false,
        currentBranch: null,
        dirtyFileCount: 0,
        incomingCommitCount: 0,
        worktrees: [],
        isWorktree: false,
        mainWorktreePath: null,
        localBranches: [],
      }),
    ).toEqual({
      kind: "non-git-directory",
      branch: null,
      repositoryPath: null,
      worktreePath: null,
    });
  });
});

describe("enrichWorkspaceAttachmentWithGitState", () => {
  it("adds repo/worktree metadata for an inferred subdirectory", () => {
    const attachment = {
      id: workspaceAttachmentIdForPath("/Users/test/goose/builderbot"),
      path: "/Users/test/goose/builderbot",
      kind: "directory" as const,
      source: "inferred" as const,
      branch: null,
      usedByAgent: false,
    };

    const enriched = enrichWorkspaceAttachmentWithGitState(
      attachment,
      gitState,
    );

    expect(enriched).toEqual({
      ...attachment,
      kind: "subdirectory",
      branch: "main",
      repositoryPath: "/Users/test/goose",
      worktreePath: "/Users/test/goose",
    });
    expect(getWorkspaceTitle(enriched)).toBe("goose/builderbot");
  });

  it("does not use relative dot segments as the repository title", () => {
    expect(
      getWorkspaceTitle(
        {
          path: "/Users/test/goose-worktrees/chat-workspaces/builderbot",
          kind: "subdirectory",
          repositoryPath: "..",
          worktreePath: "/Users/test/goose-worktrees/chat-workspaces",
        },
        gitState,
      ),
    ).toBe("goose/builderbot");
  });

  it("falls back to the first worktree when git does not mark the main checkout", () => {
    expect(
      getWorkspaceTitle(
        {
          path: "/Users/test/cash-server-worktrees/chat-workspaces/builderbot",
          kind: "subdirectory",
          repositoryPath: "..",
          worktreePath: "/Users/test/cash-server-worktrees/chat-workspaces",
        },
        {
          ...gitState,
          mainWorktreePath: "..",
          worktrees: [
            {
              path: "/Users/test/cash-server",
              branch: "main",
              isMain: false,
            },
            {
              path: "/Users/test/cash-server-worktrees/chat-workspaces",
              branch: "feature/chat-workspaces",
              isMain: false,
            },
          ],
        },
      ),
    ).toBe("cash-server/builderbot");
  });
});

describe("drive-relative workspace identity", () => {
  it("does not dedupe drive-relative paths across drives or into ordinary relative paths", () => {
    const workspaces = getWorkspaceAttachments({
      workingDir: "C:foo/../bar",
      workspaceAttachments: [
        attachment("C:foo/../bar"),
        attachment("D:foo/../bar"),
        attachment("bar"),
        attachment("C:../bar"),
        attachment("C:../../bar"),
        attachment("c:foo/../bar"),
      ],
    });

    expect(workspaces).toHaveLength(6);
    expect(new Set(workspaces.map((workspace) => workspace.id)).size).toBe(6);
  });
});

describe("getIncludedWorkspaceAttachments", () => {
  it("does not seed worktree startup project paths over a created session plan", () => {
    const session = {
      workingDir: "/repo-worktrees/chat-123/builderbot",
      workspaceAttachments: [
        attachment("/repo-worktrees/chat-123/builderbot", {
          kind: "subdirectory",
          source: "created",
          branch: "chat-123",
          repositoryPath: "/repo",
          worktreePath: "/repo-worktrees/chat-123",
        }),
      ],
      messageCount: 0,
    };

    const included = getIncludedWorkspaceAttachments(session);

    expect(included.map((workspace) => workspace.path)).toEqual([
      "/repo-worktrees/chat-123/builderbot",
    ]);
    expect(formatIncludedWorkspacesPrompt(session)).not.toContain(
      "/repo/builderbot",
    );
  });

  it("keeps startupMode none project paths alongside created worktree attachments", () => {
    const session = {
      workingDir: "/repo-worktrees/chat-123/builderbot",
      workspaceAttachments: [
        attachment("/repo", { source: "inferred" }),
        attachment("/repo-worktrees/chat-123/builderbot", {
          kind: "subdirectory",
          source: "created",
          branch: "chat-123",
          repositoryPath: "/repo",
          worktreePath: "/repo-worktrees/chat-123",
        }),
      ],
      messageCount: 0,
    };

    expect(
      getIncludedWorkspaceAttachments(session).map(
        (workspace) => workspace.path,
      ),
    ).toEqual(["/repo", "/repo-worktrees/chat-123/builderbot"]);
  });

  it("does not seed project defaults without an explicit workspace plan", () => {
    const session = {
      workingDir: "/repo/builderbot",
      messageCount: 0,
    };

    expect(
      getIncludedWorkspaceAttachments(session).map(
        (workspace) => workspace.path,
      ),
    ).toEqual([]);
  });

  it("uses only explicit chat attachments after the chat has explicit attachments", () => {
    const session = {
      workingDir: "/repo/builderbot",
      workspaceAttachments: [
        attachment("/repo/builderbot"),
        attachment("/repo/tools", { source: "selected" }),
      ],
      messageCount: 0,
    };

    expect(
      getIncludedWorkspaceAttachments(session).map(
        (workspace) => workspace.path,
      ),
    ).toEqual(["/repo/builderbot", "/repo/tools"]);
  });

  it("allows a project workspace to be re-added after a startup workspace was removed", () => {
    const session = {
      workingDir: "/repo-worktrees/chat-123/builderbot",
      workspaceAttachments: [
        attachment("/repo-worktrees/chat-123/builderbot", {
          source: "excluded",
        }),
        attachment("/repo/builderbot", { source: "selected" }),
      ],
      messageCount: 0,
    };

    expect(
      getIncludedWorkspaceAttachments(session).map(
        (workspace) => workspace.path,
      ),
    ).toEqual(["/repo/builderbot"]);
  });

  it("escapes literal included-workspaces closing tags from workspace metadata", () => {
    const prompt = formatIncludedWorkspacesPrompt({
      workingDir: "/repo</included-workspaces>/builderbot",
      workspaceAttachments: [
        attachment("/repo</included-workspaces>/builderbot", {
          source: "selected",
          branch: "feature</included-workspaces>",
        }),
      ],
      messageCount: 0,
    });

    expect(prompt).toContain("<\\/included-workspaces>");
    expect(prompt?.match(/<\/included-workspaces>/g)).toHaveLength(1);
  });
});

describe("workspace cleanup targets", () => {
  it("matches subdirectories inside the same Goose-created worktree", () => {
    const managedWorkspace = attachment("/repo-worktrees/chat-123/builderbot", {
      kind: "subdirectory",
      source: "created",
      branch: "chat-123",
      repositoryPath: "/repo",
      worktreePath: "/repo-worktrees/chat-123",
      lifecycle: {
        owner: "goose",
        cleanup: "worktree",
        branch: "chat-123",
        baseBranch: "main",
        repositoryPath: "/repo",
        worktreePath: "/repo-worktrees/chat-123",
        createdBranch: true,
      },
    });
    const target = getWorkspaceCleanupTarget(managedWorkspace);

    if (!target) {
      throw new Error("Expected managed workspace to have a cleanup target");
    }

    expect(target).toEqual({
      cleanup: "worktree",
      branch: "chat-123",
      baseBranch: "main",
      repositoryPath: "/repo",
      worktreePath: "/repo-worktrees/chat-123",
      createdBranch: true,
    });
    expect(
      workspaceAttachmentUsesCleanupTarget(
        attachment("/repo-worktrees/chat-123/bbsubscriber", {
          kind: "subdirectory",
          branch: "chat-123",
          repositoryPath: "/repo",
          worktreePath: "/repo-worktrees/chat-123",
        }),
        target,
      ),
    ).toBe(true);
    expect(
      workspaceAttachmentUsesCleanupTarget(
        attachment("/repo-worktrees/other/builderbot", {
          kind: "subdirectory",
          branch: "other",
          repositoryPath: "/repo",
          worktreePath: "/repo-worktrees/other",
        }),
        target,
      ),
    ).toBe(false);
  });

  it("treats same-checkout branch attachments with missing branch metadata as active use", () => {
    const managedWorkspace = attachment("/repo/builderbot", {
      kind: "subdirectory",
      source: "created",
      branch: "chat-123",
      repositoryPath: "/repo",
      worktreePath: "/repo",
      lifecycle: {
        owner: "goose",
        cleanup: "branch",
        branch: "chat-123",
        baseBranch: "main",
        repositoryPath: "/repo",
        worktreePath: "/repo",
        createdBranch: true,
      },
    });
    const target = getWorkspaceCleanupTarget(managedWorkspace);

    if (!target) {
      throw new Error("Expected managed workspace to have a cleanup target");
    }

    expect(
      workspaceAttachmentUsesCleanupTarget(
        attachment("/repo/bbsubscriber", {
          kind: "subdirectory",
          repositoryPath: "/repo",
          worktreePath: "/repo",
        }),
        target,
      ),
    ).toBe(true);
    expect(
      workspaceAttachmentUsesCleanupTarget(
        attachment("/repo/bbsubscriber", {
          kind: "subdirectory",
          branch: "other",
          repositoryPath: "/repo",
          worktreePath: "/repo",
        }),
        target,
      ),
    ).toBe(false);
  });

  it("matches `~`-spelled attachments against absolute cleanup targets when the home dir is known", () => {
    const managedWorkspace = attachment("/Users/test/repo", {
      kind: "git-main-worktree",
      source: "created",
      branch: "chat-123",
      repositoryPath: "/Users/test/repo",
      worktreePath: "/Users/test/repo",
      lifecycle: {
        owner: "goose",
        cleanup: "branch",
        branch: "chat-123",
        baseBranch: "main",
        repositoryPath: "/Users/test/repo",
        worktreePath: "/Users/test/repo",
        createdBranch: true,
      },
    });
    const target = getWorkspaceCleanupTarget(managedWorkspace);

    if (!target) {
      throw new Error("Expected managed workspace to have a cleanup target");
    }

    const tildeSibling = attachment("~/repo/docs", { kind: "directory" });
    // Without the home dir the raw spelling cannot match the absolute target.
    expect(workspaceAttachmentUsesCleanupTarget(tildeSibling, target)).toBe(
      false,
    );
    expect(
      workspaceAttachmentUsesCleanupTarget(tildeSibling, target, "/Users/test"),
    ).toBe(true);
    // A `~` sibling in a different checkout still does not match.
    expect(
      workspaceAttachmentUsesCleanupTarget(
        attachment("~/other-repo", { kind: "directory" }),
        target,
        "/Users/test",
      ),
    ).toBe(false);
  });

  it("matches absolute attachments against a legacy `~`-spelled cleanup target when the home dir is known", () => {
    const managedWorkspace = attachment("~/repo", {
      kind: "repository",
      source: "created",
      branch: "chat-123",
      lifecycle: {
        owner: "goose",
        cleanup: "branch",
        branch: "chat-123",
        baseBranch: "main",
        repositoryPath: "~/repo",
        worktreePath: "~/repo",
        createdBranch: true,
      },
    });
    const target = getWorkspaceCleanupTarget(managedWorkspace);

    if (!target) {
      throw new Error("Expected managed workspace to have a cleanup target");
    }

    const absoluteSibling = attachment("/Users/test/repo", {
      kind: "git-main-worktree",
      repositoryPath: "/Users/test/repo",
      worktreePath: "/Users/test/repo",
    });
    expect(workspaceAttachmentUsesCleanupTarget(absoluteSibling, target)).toBe(
      false,
    );
    expect(
      workspaceAttachmentUsesCleanupTarget(
        absoluteSibling,
        target,
        "/Users/test",
      ),
    ).toBe(true);
  });
});

describe("removeWorkspaceAttachment", () => {
  it("excludes a removed inferred project workspace from included workspaces", () => {
    const session = removeWorkspaceAttachment(
      {
        workingDir: "/Users/test/goose",
        workspaceAttachments: [] as WorkspaceAttachment[],
        messageCount: 0,
      },
      { attachmentId: workspaceAttachmentIdForPath("/Users/test/goose") },
    );

    expect(session.workspaceAttachments).toEqual([
      expect.objectContaining({
        path: "/Users/test/goose",
        source: "excluded",
      }),
    ]);
    expect(session.workingDir).toBe("/Users/test/goose");
    expect(getIncludedWorkspaceAttachments(session)).toEqual([]);
  });

  it("excludes a removed selected workspace when it matches the session working directory", () => {
    const session = removeWorkspaceAttachment(
      {
        workingDir: "/Users/test/goose",
        workspaceAttachments: [
          {
            id: workspaceAttachmentIdForPath("/Users/test/goose"),
            path: "/Users/test/goose",
            kind: "git-main-worktree",
            source: "selected",
            branch: "main",
            usedByAgent: false,
          },
        ],
        messageCount: 0,
      },
      { attachmentId: workspaceAttachmentIdForPath("/Users/test/goose") },
    );

    expect(session.workspaceAttachments).toEqual([
      expect.objectContaining({
        path: "/Users/test/goose",
        source: "excluded",
      }),
    ]);
    expect(session.workingDir).toBe("/Users/test/goose");
    expect(getIncludedWorkspaceAttachments(session)).toEqual([]);
  });

  it("does not re-seed the source project workspace after removing a created startup worktree", () => {
    const session = removeWorkspaceAttachment(
      {
        workingDir: "/repo-worktrees/chat-123/builderbot",
        workspaceAttachments: [
          attachment("/repo-worktrees/chat-123/builderbot", {
            kind: "subdirectory",
            source: "created",
            branch: "chat-123",
            repositoryPath: "/repo",
            worktreePath: "/repo-worktrees/chat-123",
          }),
        ],
        messageCount: 0,
      },
      {
        attachmentId: workspaceAttachmentIdForPath(
          "/repo-worktrees/chat-123/builderbot",
        ),
      },
    );

    expect(session.workspaceAttachments).toEqual([
      expect.objectContaining({
        path: "/repo-worktrees/chat-123/builderbot",
        source: "excluded",
      }),
    ]);
    expect(getIncludedWorkspaceAttachments(session)).toEqual([]);
  });
});

describe("windows identity across dedupe / ensure / exclude", () => {
  it("dedupes persisted attachments that differ only by Windows casing/separators", () => {
    // Legacy explicit ids so the merge is observably identity-based, not id-based.
    const session = {
      workingDir: "C:\\Repo",
      workspaceAttachments: [
        {
          id: "legacy-a",
          path: "C:\\Repo",
          kind: "directory" as const,
          source: "inferred" as const,
          branch: null,
          usedByAgent: false,
        },
        {
          id: "legacy-b",
          path: "c:/repo",
          kind: "directory" as const,
          source: "selected" as const,
          branch: null,
          usedByAgent: false,
        },
      ],
      messageCount: 0,
    };

    const attachments = getWorkspaceAttachments(session);

    expect(attachments).toHaveLength(1);
    // First-seen entry wins the merge; the display spelling is preserved.
    expect(attachments[0].path).toBe("C:\\Repo");
    expect(attachments[0].source).toBe("selected");
  });

  it("preserves the active persisted ID when deduping Windows variants", () => {
    const session = withWorkspaceBackfill({
      workingDir: String.raw`C:\Repo`,
      workspaceAttachments: [
        {
          id: "legacy-a",
          path: String.raw`C:\Repo`,
          kind: "directory" as const,
          source: "inferred" as const,
          branch: null,
          usedByAgent: false,
        },
        {
          id: "legacy-b",
          path: "c:/repo",
          kind: "directory" as const,
          source: "selected" as const,
          branch: null,
          usedByAgent: false,
        },
        {
          id: "legacy-other",
          path: String.raw`D:\Other`,
          kind: "directory" as const,
          source: "selected" as const,
          branch: null,
          usedByAgent: false,
        },
      ],
      activeWorkspaceId: "legacy-b",
      messageCount: 0,
    });

    expect(session.workspaceAttachments).toEqual([
      expect.objectContaining({
        id: "legacy-b",
        path: "c:/repo",
        source: "selected",
      }),
      expect.objectContaining({
        id: "legacy-other",
        path: String.raw`D:\Other`,
      }),
    ]);
    expect(session.activeWorkspaceId).toBe("legacy-b");
  });

  it("reuses the persisted attachment id when ensuring a Windows casing/separator variant", () => {
    const session = {
      workingDir: "C:\\Repo",
      workspaceAttachments: [
        {
          id: "legacy-id",
          path: "C:\\Repo",
          kind: "directory" as const,
          source: "selected" as const,
          branch: null,
          usedByAgent: false,
        },
      ],
      messageCount: 0,
    };

    const next = ensureWorkspaceAttachment(session, {
      path: "c:/repo",
      source: "selected",
      kind: "directory",
    });

    expect(next.workspaceAttachments).toHaveLength(1);
    expect(next.workspaceAttachments?.[0].id).toBe("legacy-id");
  });

  it("excludes a Windows casing/separator variant without leaving a duplicate", () => {
    const session = {
      workingDir: "C:\\Repo",
      workspaceAttachments: [
        {
          id: "legacy-id",
          path: "C:\\Repo",
          kind: "directory" as const,
          source: "selected" as const,
          branch: null,
          usedByAgent: false,
        },
      ],
      messageCount: 0,
    };

    // A distinct identity-derived id forces the exclude fallback path.
    const next = removeWorkspaceAttachment(session, {
      attachmentId: workspaceAttachmentIdForPath("c:/repo"),
    });

    expect(next.workspaceAttachments).toHaveLength(1);
    expect(next.workspaceAttachments?.[0].source).toBe("excluded");
  });
});

describe("isSameWorkspacePathWithHome", () => {
  it("matches home-relative and expanded spellings", () => {
    expect(
      isSameWorkspacePathWithHome(
        "~/goose artifacts",
        "/Users/me/goose artifacts",
        "/Users/me",
      ),
    ).toBe(true);
  });

  it("still distinguishes different paths", () => {
    expect(
      isSameWorkspacePathWithHome("~/goose artifacts", "/other", "/Users/me"),
    ).toBe(false);
  });

  it("does not treat a mid-path tilde as home-relative", () => {
    expect(
      isSameWorkspacePathWithHome("/tmp/~/repo", "/Users/me/repo", "/Users/me"),
    ).toBe(false);
  });
});
