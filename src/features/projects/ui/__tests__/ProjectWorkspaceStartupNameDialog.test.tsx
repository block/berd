import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectWorkspaceStartupNameDialog } from "../ProjectWorkspaceStartupNameDialog";
import type { ProjectWorkspace } from "@/features/projects/api/projects";

function projectWorkspace(
  path: string,
  startupMode: ProjectWorkspace["startupMode"] = "worktree",
): ProjectWorkspace {
  return {
    id: `path:${path}`,
    path,
    kind: "subdirectory",
    source: "selected",
    repositoryPath: "/repo",
    worktreePath: "/repo",
    branch: "main",
    usedByAgent: false,
    startupMode,
  };
}

describe("ProjectWorkspaceStartupNameDialog", () => {
  it("clears input when an open dialog advances to another request", async () => {
    const user = userEvent.setup();
    const firstRequest = {};
    const secondRequest = {};
    const props = {
      open: true,
      requestIdentity: firstRequest,
      workspaces: [projectWorkspace("/repo/builderbot")],
      onCancel: vi.fn(),
      onSkip: vi.fn(),
      onSubmit: vi.fn(),
    };
    const { rerender } = render(
      <ProjectWorkspaceStartupNameDialog {...props} />,
    );

    const input = screen.getByRole("textbox", {
      name: "Worktree/branch name",
    });
    await user.type(input, "first-name");
    expect(input).toHaveValue("first-name");

    rerender(
      <ProjectWorkspaceStartupNameDialog
        {...props}
        requestIdentity={secondRequest}
      />,
    );

    expect(input).toHaveValue("");
  });

  it.each([
    "feature/foo",
    "feature\\foo",
    ".",
    "..",
  ])("blocks invalid worktree name %s", async (startupName) => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(
      <ProjectWorkspaceStartupNameDialog
        open={true}
        requiresWorktreeSafeName={true}
        workspaces={[projectWorkspace("/repo/builderbot")]}
        onCancel={vi.fn()}
        onSkip={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    await user.type(
      screen.getByRole("textbox", { name: "Worktree/branch name" }),
      startupName,
    );

    expect(
      screen.getByText(
        "Use a folder name other than . or .. and without slash or backslash characters.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("allows branch-only startup names that include path separators", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(
      <ProjectWorkspaceStartupNameDialog
        open={true}
        requiresWorktreeSafeName={false}
        workspaces={[projectWorkspace("/repo/builderbot", "branch")]}
        onCancel={vi.fn()}
        onSkip={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    await user.type(
      screen.getByRole("textbox", { name: "Worktree/branch name" }),
      "feature/foo",
    );
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(onSubmit).toHaveBeenCalledWith("feature/foo");
  });

  it("shows the startup effect preview and allows using the default configuration", async () => {
    const user = userEvent.setup();
    const onSkip = vi.fn();

    render(
      <ProjectWorkspaceStartupNameDialog
        open={true}
        workspaces={[
          projectWorkspace("/repo/builderbot", "worktree"),
          projectWorkspace("/repo/worker", "branch"),
          projectWorkspace("/repo/docs", "none"),
        ]}
        onCancel={vi.fn()}
        onSkip={onSkip}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText("New chat setup")).toBeInTheDocument();
    expect(screen.getByText("repo/builderbot")).toBeInTheDocument();
    expect(screen.getByText("repo/worker")).toBeInTheDocument();
    expect(screen.getByText("repo/docs")).toBeInTheDocument();
    expect(screen.getByText("Use as-is")).toBeInTheDocument();
    expect(screen.getByText("New worktree")).toBeInTheDocument();
    expect(screen.getByText("New branch")).toBeInTheDocument();

    await user.type(
      screen.getByRole("textbox", { name: "Worktree/branch name" }),
      "chat-123",
    );

    expect(screen.getAllByText("chat-123")).toHaveLength(2);
    expect(screen.queryByText("chat-123/builderbot")).not.toBeInTheDocument();
    expect(screen.queryByText("chat-123/worker")).not.toBeInTheDocument();
    expect(screen.getByText("repo/docs")).toBeInTheDocument();
    expect(screen.getByText("Use as-is")).toBeInTheDocument();

    const skipButton = screen.getByRole("button", {
      name: "Skip and use as-is",
    });
    await user.hover(skipButton);
    for (const preview of screen.getAllByText("chat-123")) {
      expect(preview.parentElement).toHaveClass("line-through");
    }
    expect(screen.getByText("Use as-is").parentElement).not.toHaveClass(
      "line-through",
    );

    await user.click(skipButton);

    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
