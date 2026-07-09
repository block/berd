import { beforeEach, describe, expect, it } from "vitest";
import { MULTI_WORKSPACE_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { setExperimentEnabled } from "@/features/experiments/experimentPreferences";
import { workspaceAttachmentIdForPath } from "@/features/chat/lib/workspaceAttachments";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import { getWorkspaceRepository } from "./workspaceRepository";

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

describe("WorkspaceRepository", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("includes the explicitly saved cwd in multi mode", () => {
    setExperimentEnabled(MULTI_WORKSPACE_EXPERIMENT_ID, true);

    const workspaceSet = getWorkspaceRepository().chatWorkspaces({
      workingDir: "/tmp/general-chat",
      workspaceAttachments: [
        {
          id: workspaceAttachmentIdForPath("/tmp/general-chat"),
          path: "/tmp/general-chat",
          kind: "directory",
          source: "inferred",
          branch: null,
          usedByAgent: true,
        },
      ],
      messageCount: 1,
    });

    expect(workspaceSet.mode).toBe("multi");
    expect(workspaceSet.workspaces).toEqual([
      expect.objectContaining({
        path: "/tmp/general-chat",
        usedByAgent: true,
      }),
    ]);
    expect(workspaceSet.primary).toMatchObject({
      path: "/tmp/general-chat",
      usedByAgent: true,
    });
  });

  it("uses the persisted active workspace in single mode", () => {
    setExperimentEnabled(MULTI_WORKSPACE_EXPERIMENT_ID, false);

    const activeWorkspaceId = workspaceAttachmentIdForPath("/repo-linked");
    const workspaceSet = getWorkspaceRepository().chatWorkspaces({
      workingDir: "/repo-main",
      activeWorkspaceId,
      workspaceAttachments: [
        {
          id: workspaceAttachmentIdForPath("/repo-main"),
          path: "/repo-main",
          kind: "git-main-worktree",
          source: "inferred",
          branch: "main",
          usedByAgent: false,
        },
        {
          id: activeWorkspaceId,
          path: "/repo-linked",
          kind: "git-linked-worktree",
          source: "selected",
          branch: "feature",
          usedByAgent: false,
        },
      ],
      messageCount: 0,
    });

    expect(workspaceSet.mode).toBe("single");
    expect(workspaceSet.workspaces).toHaveLength(1);
    expect(workspaceSet.primary).toMatchObject({
      path: "/repo-linked",
      branch: "feature",
    });
  });

  it("preserves matching attachment metadata in single mode when no active workspace is set", () => {
    setExperimentEnabled(MULTI_WORKSPACE_EXPERIMENT_ID, false);

    const workspaceSet = getWorkspaceRepository().chatWorkspaces({
      workingDir: "/repo-linked",
      workspaceAttachments: [
        {
          id: workspaceAttachmentIdForPath("/repo-linked"),
          path: "/repo-linked",
          kind: "git-linked-worktree",
          source: "selected",
          branch: "feature",
          repositoryPath: "/repo-main",
          worktreePath: "/repo-linked",
          usedByAgent: false,
        },
      ],
      messageCount: 0,
    });

    expect(workspaceSet.mode).toBe("single");
    expect(workspaceSet.primary).toMatchObject({
      path: "/repo-linked",
      kind: "git-linked-worktree",
      branch: "feature",
      repositoryPath: "/repo-main",
      worktreePath: "/repo-linked",
    });
  });

  it("does not add worktree startup project paths to a created chat workspace plan", () => {
    setExperimentEnabled(MULTI_WORKSPACE_EXPERIMENT_ID, true);

    const workspaceSet = getWorkspaceRepository().chatWorkspaces({
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
    });

    expect(workspaceSet.workspaces.map((workspace) => workspace.path)).toEqual([
      "/repo-worktrees/chat-123/builderbot",
    ]);
    expect(workspaceSet.primary?.path).toBe(
      "/repo-worktrees/chat-123/builderbot",
    );
  });

  it("keeps as-is project paths materialized into a created chat workspace plan", () => {
    setExperimentEnabled(MULTI_WORKSPACE_EXPERIMENT_ID, true);

    const workspaceSet = getWorkspaceRepository().chatWorkspaces({
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
    });

    expect(workspaceSet.workspaces.map((workspace) => workspace.path)).toEqual([
      "/repo",
      "/repo-worktrees/chat-123/builderbot",
    ]);
  });
});
