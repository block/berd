import { describe, expect, it } from "vitest";
import {
  getWorkspaceIdentityIconKind,
  getWorkspaceIdentityMetadataItems,
} from "./WorkspaceIdentity";

const labels = {
  mainCheckout: "main checkout",
  worktree: "worktree",
};

describe("workspace identity icon semantics", () => {
  it("uses folder for non-git and git folder for git-backed workspaces", () => {
    expect(
      getWorkspaceIdentityIconKind({
        isGitBacked: false,
        isLinkedWorktree: false,
      }),
    ).toBe("folder");
    expect(
      getWorkspaceIdentityIconKind({
        isGitBacked: true,
        isLinkedWorktree: false,
      }),
    ).toBe("repository");
    expect(
      getWorkspaceIdentityIconKind({
        isGitBacked: true,
        isLinkedWorktree: false,
      }),
    ).toBe("repository");
    expect(
      getWorkspaceIdentityIconKind({
        isGitBacked: true,
        isLinkedWorktree: true,
      }),
    ).toBe("repository");
    expect(
      getWorkspaceIdentityIconKind({
        isGitBacked: true,
        isLinkedWorktree: false,
      }),
    ).toBe("repository");
  });
});

describe("workspace identity metadata", () => {
  it("does not add folder metadata labels for ordinary folders", () => {
    expect(
      getWorkspaceIdentityMetadataItems(
        {
          isGitBacked: false,
          isLinkedWorktree: false,
          isBranchCheckout: false,
          branch: null,
          worktreeName: null,
        },
        labels,
      ),
    ).toEqual([]);
  });

  it("shows main checkout identity without checked-out branch metadata", () => {
    expect(
      getWorkspaceIdentityMetadataItems(
        {
          isGitBacked: true,
          isLinkedWorktree: false,
          isBranchCheckout: false,
          branch: "main",
          worktreeName: null,
        },
        labels,
      ),
    ).toEqual([{ label: "main checkout" }]);
  });

  it("shows non-default checked-out branch metadata for repositories", () => {
    expect(
      getWorkspaceIdentityMetadataItems(
        {
          isGitBacked: true,
          isLinkedWorktree: false,
          isBranchCheckout: true,
          branch: "feature/builderbot",
          worktreeName: null,
        },
        labels,
      ),
    ).toEqual([{ label: "feature/builderbot", icon: "branch" }]);
  });

  it("does not add default branch metadata for repositories", () => {
    for (const branch of ["main", "master", "trunk"]) {
      expect(
        getWorkspaceIdentityMetadataItems(
          {
            isGitBacked: true,
            isLinkedWorktree: false,
            isBranchCheckout: false,
            branch,
            worktreeName: null,
          },
          labels,
        ),
      ).toEqual([{ label: "main checkout" }]);
    }
  });

  it("shows linked worktree identity without checked-out branch metadata", () => {
    expect(
      getWorkspaceIdentityMetadataItems(
        {
          isGitBacked: true,
          isLinkedWorktree: true,
          isBranchCheckout: false,
          branch: "feature/builderbot",
          worktreeName: "workspace-icons",
        },
        labels,
      ),
    ).toEqual([{ label: "workspace-icons", icon: "worktree" }]);
  });
});
