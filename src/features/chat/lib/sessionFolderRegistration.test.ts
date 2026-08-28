import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  attachSessionFolder,
  detachSessionFolder,
  replaceSessionFolder,
} from "./sessionFolderRegistration";

const mocks = vi.hoisted(() => ({
  canonicalizeAuthorizedWorkspaceDirectory: vi.fn(),
  resolvePath: vi.fn(),
  getGitState: vi.fn(),
  getHomeDir: vi.fn(),
  resolveArtifactRootPath: vi.fn(),
}));
vi.mock("@/shared/api/pathResolver", () => ({
  canonicalizeAuthorizedWorkspaceDirectory: (...args: unknown[]) =>
    mocks.canonicalizeAuthorizedWorkspaceDirectory(...args),
  resolvePath: (...args: unknown[]) => mocks.resolvePath(...args),
}));
vi.mock("@/shared/api/git", () => ({
  getGitState: (...args: unknown[]) => mocks.getGitState(...args),
}));
vi.mock("@/shared/api/system", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/system")>();
  return {
    ...actual,
    getHomeDir: (...args: unknown[]) => mocks.getHomeDir(...args),
  };
});
vi.mock(
  "@/shared/artifacts/sessionArtifactLocation",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/shared/artifacts/sessionArtifactLocation")
      >();
    return {
      ...actual,
      resolveArtifactRootPath: () => mocks.resolveArtifactRootPath(),
    };
  },
);

const session = {
  id: "session-1",
  title: "Test",
  workingDir: "/repo",
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
  messageCount: 1,
};
const gitState = {
  isGitRepo: true,
  currentBranch: "feature",
  dirtyFileCount: 0,
  incomingCommitCount: 0,
  worktrees: [
    { path: "/repo", branch: "main", isMain: true },
    { path: "/repo-wt", branch: "feature", isMain: false },
  ],
  isWorktree: true,
  mainWorktreePath: "/repo",
  localBranches: ["main", "feature"],
};

describe("attachSessionFolder", () => {
  beforeEach(() => {
    localStorage.clear();
    useChatSessionStore.setState({
      sessions: [{ ...session }],
      activeSessionId: null,
      activeWorkspaceBySession: {},
      hasHydratedSessions: true,
    });
    mocks.canonicalizeAuthorizedWorkspaceDirectory
      .mockReset()
      .mockImplementation(async ({ path }: { path: string }) => ({
        path: path === "/repo-wt/../repo-wt" ? "/repo-wt" : path,
      }));
    mocks.resolvePath
      .mockReset()
      .mockImplementation(async ({ parts }: { parts: string[] }) => ({
        path: parts[0],
      }));
    mocks.getGitState.mockReset().mockResolvedValue(gitState);
    mocks.getHomeDir.mockReset().mockResolvedValue("/Users/me");
    mocks.resolveArtifactRootPath.mockReset().mockResolvedValue("/artifacts");
  });

  it("classifies, persists, and idempotently refreshes an attachment", async () => {
    await attachSessionFolder("session-1", "/repo-wt/../repo-wt");
    expect(mocks.canonicalizeAuthorizedWorkspaceDirectory).toHaveBeenCalledWith(
      {
        path: "/repo-wt/../repo-wt",
        allowedRoots: ["/repo", "/repo-wt"],
      },
    );
    await attachSessionFolder("session-1", "/repo-wt");

    const attachments = useChatSessionStore
      .getState()
      .getSession("session-1")?.workspaceAttachments;
    expect(attachments).toHaveLength(2); // saved cwd backfill + new worktree
    expect(attachments?.find((item) => item.path === "/repo-wt")).toMatchObject(
      {
        kind: "git-linked-worktree",
        branch: "feature",
        repositoryPath: "/repo",
        worktreePath: "/repo-wt",
        source: "inferred",
        usedByAgent: true,
      },
    );
    expect(localStorage.getItem("goose:chat-workspace-metadata")).toContain(
      "/repo-wt",
    );
  });

  it("rejects attach/detach/replace for remote sessions before touching local path checks", async () => {
    useChatSessionStore.setState({
      sessions: [{ ...session, remoteHost: "devbox" }],
    });

    await expect(
      attachSessionFolder("session-1", "/repo-wt"),
    ).rejects.toMatchObject({
      name: "FolderAttachmentError",
      message: expect.stringContaining("devbox"),
    });
    await expect(
      detachSessionFolder("session-1", "/repo"),
    ).rejects.toMatchObject({ name: "FolderAttachmentError" });
    await expect(
      replaceSessionFolder("session-1", "/repo", "/repo-wt"),
    ).rejects.toMatchObject({ name: "FolderAttachmentError" });

    // The guard fires before any local canonicalization or git probe: those
    // Tauri commands act on the local filesystem and the session's paths
    // live on the SSH host.
    expect(
      mocks.canonicalizeAuthorizedWorkspaceDirectory,
    ).not.toHaveBeenCalled();
    expect(mocks.resolvePath).not.toHaveBeenCalled();
    expect(mocks.getGitState).not.toHaveBeenCalled();
    expect(
      useChatSessionStore.getState().getSession("session-1")
        ?.workspaceAttachments ?? [],
    ).toHaveLength(0);
  });

  it("merges concurrent registrations against current store state", async () => {
    const first = attachSessionFolder("session-1", "/first");
    const second = attachSessionFolder("session-1", "/second");
    await Promise.all([first, second]);

    const paths = useChatSessionStore
      .getState()
      .getSession("session-1")
      ?.workspaceAttachments?.map((item) => item.path);
    expect(paths).toEqual(expect.arrayContaining(["/first", "/second"]));
  });

  it("rejects a stale registration after its authorized root is removed", async () => {
    let releaseInspection: (() => void) | undefined;
    const inspectionBlocked = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    let gitCalls = 0;
    mocks.getGitState.mockImplementation(async (path: string) => {
      gitCalls += 1;
      if (gitCalls === 2) await inspectionBlocked;
      if (path === "/replacement") {
        return { ...gitState, isGitRepo: false, worktrees: [] };
      }
      return gitState;
    });

    const registration = attachSessionFolder("session-1", "/repo/child");
    await vi.waitFor(() => expect(gitCalls).toBe(2));
    useChatSessionStore.setState({
      sessions: [{ ...session, workingDir: "/replacement" }],
    });
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockImplementation(
      async ({
        path,
        allowedRoots,
      }: {
        path: string;
        allowedRoots: string[];
      }) => {
        if (!allowedRoots.some((root) => path.startsWith(root))) {
          throw new Error("outside authorized roots");
        }
        return { path };
      },
    );
    releaseInspection?.();

    await expect(registration).rejects.toThrow("outside authorized roots");
    expect(
      useChatSessionStore
        .getState()
        .getSession("session-1")
        ?.workspaceAttachments?.some(
          (attachment) => attachment.path === "/repo/child",
        ),
    ).not.toBe(true);
  });

  it("rejects authorization revoked after preparation but before mutation", async () => {
    let releaseArtifactRoot: (() => void) | undefined;
    const artifactRootBlocked = new Promise<void>((resolve) => {
      releaseArtifactRoot = resolve;
    });
    mocks.resolveArtifactRootPath.mockImplementationOnce(async () => {
      await artifactRootBlocked;
      return "/artifacts";
    });
    mocks.getGitState.mockImplementation(async (path: string) =>
      path === "/replacement"
        ? { ...gitState, isGitRepo: false, worktrees: [] }
        : gitState,
    );
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockImplementation(
      async ({
        path,
        allowedRoots,
      }: {
        path: string;
        allowedRoots: string[];
      }) => {
        if (!allowedRoots.some((root) => path.startsWith(root))) {
          throw new Error("outside authorized roots");
        }
        return { path };
      },
    );

    const registration = attachSessionFolder("session-1", "/repo/child");
    await vi.waitFor(() =>
      expect(mocks.resolveArtifactRootPath).toHaveBeenCalledTimes(1),
    );
    useChatSessionStore.setState({
      sessions: [{ ...session, workingDir: "/replacement" }],
    });
    releaseArtifactRoot?.();

    await expect(registration).rejects.toThrow("outside authorized roots");
    expect(
      useChatSessionStore
        .getState()
        .getSession("session-1")
        ?.workspaceAttachments?.some(
          (attachment) => attachment.path === "/repo/child",
        ),
    ).not.toBe(true);
  });

  it("does not let an excluded attachment expand path authority", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          ...session,
          workspaceAttachments: [
            {
              id: "path:/secret",
              path: "/secret",
              kind: "directory",
              source: "excluded",
              branch: null,
              usedByAgent: false,
            },
          ],
        },
      ],
    });

    await attachSessionFolder("session-1", "/repo/child");

    expect(mocks.canonicalizeAuthorizedWorkspaceDirectory).toHaveBeenCalledWith(
      {
        path: "/repo/child",
        allowedRoots: ["/repo", "/repo-wt"],
      },
    );
    expect(mocks.getGitState).not.toHaveBeenCalledWith("/secret");
  });

  it("rejects a path when canonical directory verification fails", async () => {
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockRejectedValue(
      new Error("not a directory"),
    );
    await expect(
      attachSessionFolder("session-1", "/secret.txt"),
    ).rejects.toThrow("not a directory");
    expect(
      useChatSessionStore.getState().getSession("session-1")
        ?.workspaceAttachments,
    ).toBeUndefined();
  });
  it("detaches and persists an attachment without changing workingDir", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          ...session,
          workspaceAttachments: [
            {
              id: "path:/repo-wt",
              path: "/repo-wt",
              kind: "git-linked-worktree",
              source: "selected",
              branch: "feature",
              usedByAgent: true,
            },
          ],
        },
      ],
    });

    const result = await detachSessionFolder(
      "session-1",
      "/repo-wt/../repo-wt",
    );

    expect(result).toEqual({
      path: "/repo-wt",
      detached: true,
      cwd: "/repo",
      cwdStatus: "unchanged",
    });
    const updated = useChatSessionStore.getState().getSession("session-1");
    expect(updated?.workingDir).toBe("/repo");
    expect(
      updated?.workspaceAttachments?.some((item) => item.path === "/repo-wt"),
    ).toBe(false);
    expect(
      localStorage.getItem("goose:chat-workspace-metadata") ?? "",
    ).not.toContain("/repo-wt");
  });

  it("idempotently leaves an authorized unattached path unchanged", async () => {
    const first = await detachSessionFolder("session-1", "/repo/child");
    const second = await detachSessionFolder("session-1", "/repo/child");

    expect(first).toEqual({
      path: "/repo/child",
      detached: false,
      cwd: "/repo",
      cwdStatus: "unchanged",
    });
    expect(second).toEqual(first);
  });

  it("detaches a stored attachment even when the folder no longer exists", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          ...session,
          workspaceAttachments: [
            {
              id: "path:/repo-wt",
              path: "/repo-wt",
              kind: "git-linked-worktree",
              source: "selected",
              branch: "feature",
              usedByAgent: true,
            },
          ],
        },
      ],
    });
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockRejectedValue(
      new Error("not a directory"),
    );

    mocks.resolvePath.mockResolvedValueOnce({ path: "/repo-wt" });
    await expect(
      detachSessionFolder("session-1", "~/repo-wt"),
    ).resolves.toMatchObject({ path: "/repo-wt", detached: true });
    expect(mocks.resolvePath).toHaveBeenCalledWith({ parts: ["~/repo-wt"] });
    expect(
      mocks.canonicalizeAuthorizedWorkspaceDirectory,
    ).not.toHaveBeenCalled();
  });

  it("keeps the old attachment when replacement validation fails", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          ...session,
          workspaceAttachments: [
            {
              id: "path:/repo",
              path: "/repo",
              kind: "git-main-worktree",
              source: "selected",
              branch: "main",
              usedByAgent: true,
            },
          ],
        },
      ],
    });
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockImplementation(
      async ({ path }: { path: string }) => {
        if (path === "/secret") throw new Error("outside authorized roots");
        return { path };
      },
    );

    await expect(
      replaceSessionFolder("session-1", "/repo", "/secret"),
    ).rejects.toThrow("outside authorized roots");
    expect(
      useChatSessionStore
        .getState()
        .getSession("session-1")
        ?.workspaceAttachments?.find((item) => item.path === "/repo"),
    ).toMatchObject({ source: "selected", branch: "main" });
  });

  it("rejects replacement when the old folder is not attached", async () => {
    await expect(
      replaceSessionFolder("session-1", "/repo/child", "/repo-wt"),
    ).rejects.toThrow("is not attached");
    expect(
      useChatSessionStore
        .getState()
        .getSession("session-1")
        ?.workspaceAttachments?.some((item) => item.path === "/repo-wt"),
    ).not.toBe(true);
  });

  it("preserves the replaced attachment's array position", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          ...session,
          workspaceAttachments: [
            {
              id: "path:/first",
              path: "/first",
              kind: "directory",
              source: "selected",
              branch: null,
              usedByAgent: true,
            },
            {
              id: "path:/repo",
              path: "/repo",
              kind: "git-main-worktree",
              source: "selected",
              branch: "main",
              usedByAgent: true,
            },
            {
              id: "path:/last",
              path: "/last",
              kind: "directory",
              source: "selected",
              branch: null,
              usedByAgent: true,
            },
          ],
        },
      ],
    });

    await replaceSessionFolder("session-1", "/repo", "/repo-wt");

    expect(
      useChatSessionStore
        .getState()
        .getSession("session-1")
        ?.workspaceAttachments?.map((item) => item.path),
    ).toEqual(["/first", "/repo-wt", "/last"]);
  });

  it("re-evaluates cwd ownership after replacement validation", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          ...session,
          workingDir: "/other",
          workspaceAttachments: [
            {
              id: "path:/repo",
              path: "/repo",
              kind: "git-main-worktree",
              source: "selected",
              branch: "main",
              usedByAgent: true,
            },
          ],
        },
      ],
    });
    let releaseInspection: (() => void) | undefined;
    const inspectionBlocked = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    mocks.getGitState.mockImplementationOnce(async () => {
      await inspectionBlocked;
      return gitState;
    });

    const replacement = replaceSessionFolder("session-1", "/repo", "/repo-wt");
    await vi.waitFor(() => expect(mocks.getGitState).toHaveBeenCalled());
    useChatSessionStore.getState().patchSession("session-1", {
      workingDir: "/repo",
    });
    releaseInspection?.();

    await expect(replacement).resolves.toMatchObject({
      cwd: "/repo-wt",
      cwdStatus: "pending",
    });
  });

  it("replaces an attached folder after validating the replacement", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          ...session,
          workspaceAttachments: [
            {
              id: "path:/repo",
              path: "/repo",
              kind: "git-main-worktree",
              source: "selected",
              branch: "main",
              usedByAgent: true,
            },
          ],
        },
      ],
    });

    const result = await replaceSessionFolder("session-1", "/repo", "/repo-wt");

    expect(result).toEqual({
      oldPath: "/repo",
      newPath: "/repo-wt",
      kind: "git-linked-worktree",
      branch: "feature",
      cwd: "/repo-wt",
      cwdStatus: "pending",
    });
    const updated = useChatSessionStore.getState().getSession("session-1");
    expect(updated?.workingDir).toBe("/repo");
    expect(updated?.workspaceAttachments).toEqual([
      expect.objectContaining({ path: "/repo-wt", branch: "feature" }),
    ]);
  });
  it("promotes the first real attachment over Berd's implicit default cwd", async () => {
    useChatSessionStore.setState({
      sessions: [{ ...session, workingDir: "~/goose artifacts" }],
    });

    await attachSessionFolder("session-1", "/repo-wt");

    const { getPendingSessionWorkspaceActivation } = await import(
      "@/features/chat/lib/sessionWorkspaceActivation"
    );
    expect(getPendingSessionWorkspaceActivation("session-1")).toMatchObject({
      path: "/repo-wt",
      branch: "feature",
    });
    expect(
      useChatSessionStore
        .getState()
        .getSession("session-1")
        ?.workspaceAttachments?.filter(
          (attachment) => attachment.source !== "excluded",
        )
        .map((attachment) => attachment.path),
    ).toEqual(["/repo-wt"]);
  });

  it("rechecks the implicit cwd before pruning its attachment", async () => {
    useChatSessionStore.setState({
      sessions: [{ ...session, workingDir: "~/goose artifacts" }],
    });

    await attachSessionFolder("session-1", "/repo-wt", {
      beforeMutation: () => {
        useChatSessionStore.setState({
          sessions: [{ ...session, workingDir: "/repo" }],
        });
      },
    });

    expect(
      useChatSessionStore
        .getState()
        .getSession("session-1")
        ?.workspaceAttachments?.filter(
          (attachment) => attachment.source !== "excluded",
        )
        .map((attachment) => attachment.path),
    ).toEqual(expect.arrayContaining(["/repo", "/repo-wt"]));
  });

  it("does not promote a later attachment over an explicit cwd", async () => {
    await attachSessionFolder("session-1", "/repo-wt");
    const { getPendingSessionWorkspaceActivation } = await import(
      "@/features/chat/lib/sessionWorkspaceActivation"
    );
    expect(getPendingSessionWorkspaceActivation("session-1")).toBeNull();
  });

  it("falls back to the first remaining attachment when detaching cwd", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          ...session,
          workspaceAttachments: [
            {
              id: "path:/repo",
              path: "/repo",
              kind: "git-main-worktree",
              source: "selected",
              branch: "main",
              usedByAgent: true,
            },
            {
              id: "path:/repo-wt",
              path: "/repo-wt",
              kind: "git-linked-worktree",
              source: "selected",
              branch: "feature",
              usedByAgent: true,
            },
          ],
          activeWorkspaceId: "path:/repo",
        },
      ],
    });

    const result = await detachSessionFolder("session-1", "/repo");

    expect(result).toMatchObject({
      detached: true,
      cwd: "/repo-wt",
      cwdStatus: "pending",
    });
    const { getPendingSessionWorkspaceActivation } = await import(
      "@/features/chat/lib/sessionWorkspaceActivation"
    );
    expect(getPendingSessionWorkspaceActivation("session-1")).toMatchObject({
      path: "/repo-wt",
    });
  });

  it("attaches over a home-spelled implicit default in single-workspace mode", async () => {
    const { setMultiWorkspaceEnabled } = await import(
      "@/features/workspaces/multiWorkspacePreference"
    );
    setMultiWorkspaceEnabled(false);
    try {
      useChatSessionStore.setState({
        sessions: [
          {
            ...session,
            workingDir: "/Users/me/goose artifacts",
            workspaceAttachments: [
              {
                id: "path:~/goose artifacts",
                path: "~/goose artifacts",
                kind: "directory",
                source: "inferred",
                usedByAgent: true,
              },
            ],
          },
        ],
      });
      mocks.resolveArtifactRootPath.mockResolvedValue(
        "/Users/me/goose artifacts",
      );

      await expect(
        attachSessionFolder("session-1", "/repo-wt", {
          enforceWorkspaceLimit: true,
        }),
      ).resolves.toMatchObject({ path: "/repo-wt" });
      expect(
        useChatSessionStore
          .getState()
          .getSession("session-1")
          ?.workspaceAttachments?.filter(
            (attachment) => attachment.source !== "excluded",
          )
          .map(({ path }) => path),
      ).toEqual(["/repo-wt"]);
    } finally {
      setMultiWorkspaceEnabled(true);
    }
  });

  it("replaces an implicit default whose stored path uses the other home spelling", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          ...session,
          workingDir: "/Users/me/goose artifacts",
          workspaceAttachments: [
            {
              id: "path:~/goose artifacts",
              path: "~/goose artifacts",
              kind: "directory",
              source: "inferred",
              usedByAgent: true,
            },
          ],
        },
      ],
    });
    mocks.resolvePath.mockImplementation(
      async ({ parts }: { parts: string[] }) => ({
        path: parts[0].replace(/^~/, "/Users/me"),
      }),
    );

    await expect(
      replaceSessionFolder(
        "session-1",
        "/Users/me/goose artifacts",
        "/repo-wt",
      ),
    ).resolves.toMatchObject({
      oldPath: "~/goose artifacts",
      newPath: "/repo-wt",
      cwd: "/repo-wt",
      cwdStatus: "pending",
    });
    expect(
      useChatSessionStore
        .getState()
        .getSession("session-1")
        ?.workspaceAttachments?.filter(
          (attachment) => attachment.source !== "excluded",
        )
        .map(({ path }) => path),
    ).toEqual(["/repo-wt"]);
  });
});
