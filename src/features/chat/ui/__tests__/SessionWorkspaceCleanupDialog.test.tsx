import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionWorkspaceCleanupDialog } from "../SessionWorkspaceCleanupDialog";

const defaults = {
  open: true,
  onCancel: vi.fn(),
  onConfirm: vi.fn(),
};

describe("SessionWorkspaceCleanupDialog", () => {
  it.each([
    {
      name: "worktrees",
      worktreeCount: 1,
      branchCount: 0,
      title: "Archive chat and remove its worktrees?",
      description: /remove its Goose-created worktrees/i,
    },
    {
      name: "branches",
      worktreeCount: 0,
      branchCount: 1,
      title: "Archive chat and remove its branches?",
      description: /remove its Goose-created branches/i,
    },
    {
      name: "worktrees and branches",
      worktreeCount: 1,
      branchCount: 1,
      title: "Archive chat and remove its worktrees and branches?",
      description: /remove its Goose-created worktrees and branches/i,
    },
  ])("names $name instead of workspaces", (testCase) => {
    render(
      <SessionWorkspaceCleanupDialog
        {...defaults}
        worktreeCount={testCase.worktreeCount}
        branchCount={testCase.branchCount}
      />,
    );

    expect(
      screen.getByRole("heading", { name: testCase.title }),
    ).toBeInTheDocument();
    expect(screen.getByText(testCase.description)).toBeInTheDocument();
    expect(screen.queryByText(/workspace/i)).not.toBeInTheDocument();
  });
});
