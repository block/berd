import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GitState } from "@/shared/types/git";
import { WorkspaceCreateDialog } from "../WorkspaceCreateDialog";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const GIT_STATE: GitState = {
  isGitRepo: true,
  currentBranch: "main",
  dirtyFileCount: 0,
  incomingCommitCount: 0,
  worktrees: [
    {
      path: "/Users/test/goose2",
      branch: "main",
      isMain: true,
    },
  ],
  isWorktree: false,
  mainWorktreePath: "/Users/test/goose2",
  localBranches: ["main", "dev"],
};

describe("WorkspaceCreateDialog", () => {
  it("publishes the created worktree as the active context for legacy callers", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onContextChange = vi.fn();
    const onCreateWorktree = vi.fn().mockResolvedValue({
      path: "/Users/test/goose2-worktrees/new-worktree",
      branch: "new-worktree",
    });

    render(
      <WorkspaceCreateDialog
        mode="worktree"
        gitState={GIT_STATE}
        currentPath="/Users/test/goose2"
        onClose={onClose}
        onContextChange={onContextChange}
        onCreateWorktree={onCreateWorktree}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: /new worktree/i });
    await user.type(
      within(dialog).getByLabelText(/worktree name/i),
      "new-worktree",
    );
    await user.click(
      within(dialog).getByRole("button", { name: /^create worktree$/i }),
    );

    await waitFor(() => {
      expect(onCreateWorktree).toHaveBeenCalledWith(
        "/Users/test/goose2",
        "new-worktree",
        "new-worktree",
        true,
        "main",
      );
    });
    expect(onContextChange).toHaveBeenCalledWith({
      path: "/Users/test/goose2-worktrees/new-worktree",
      branch: "new-worktree",
    });
    expect(onClose).toHaveBeenCalled();
  });
});
