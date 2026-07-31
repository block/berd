import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceSetupChoice } from "./WorkspaceSetupChoice";

describe("WorkspaceSetupChoice", () => {
  it("matches Cynthia's collapsed prompt interaction", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onSkip = vi.fn();
    render(
      <WorkspaceSetupChoice
        state="choice"
        onCancelName={vi.fn()}
        onCreate={onCreate}
        onSubmitName={vi.fn()}
        onSkip={onSkip}
      />,
    );

    expect(
      screen.getByText("Configure your new worktree?"),
    ).toBeInTheDocument();
    const skipButton = screen.getByRole("button", { name: "Skip" });
    expect(skipButton).toBeVisible();
    await user.click(skipButton);
    expect(onSkip).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Yes" }));
    expect(screen.getByRole("button", { name: "Yes" })).toHaveClass(
      "rounded-full",
    );
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it("discloses mixed worktree and branch startup actions", () => {
    render(
      <WorkspaceSetupChoice
        state="choice"
        worktreeCount={2}
        branchCount={1}
        onCancelName={vi.fn()}
        onCreate={vi.fn()}
        onSubmitName={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Configure 2 new worktrees and 1 new branch?"),
    ).toBeInTheDocument();
  });

  it("uses generic copy when startup action counts are not exact", () => {
    render(
      <WorkspaceSetupChoice
        state="choice"
        worktreeCount={2}
        exactCounts={false}
        onCancelName={vi.fn()}
        onCreate={vi.fn()}
        onSubmitName={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Configure new project workspaces?"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/2 new worktrees/)).not.toBeInTheDocument();
  });

  it("expands inline to collect a safe worktree name or cancel", async () => {
    const user = userEvent.setup();
    const onCancelName = vi.fn();
    const onSubmitName = vi.fn();
    render(
      <WorkspaceSetupChoice
        state="naming"
        workspaces={[
          {
            id: "workspace-1",
            path: "/Berd-internal",
            kind: "repository",
            source: "selected",
            usedByAgent: true,
            repositoryPath: "/Berd-internal",
            startupMode: "worktree",
          },
        ]}
        onCancelName={onCancelName}
        onCreate={vi.fn()}
        onSubmitName={onSubmitName}
        onSkip={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Worktree name" });
    expect(
      screen.getByRole("combobox", { name: "Project folder" }),
    ).toHaveValue("/Berd-internal");
    expect(
      screen.getByRole("option", { name: "Berd-internal" }),
    ).toBeInTheDocument();
    expect(input.parentElement?.parentElement).toHaveClass(
      "grid-cols-1",
      "sm:grid-cols-[minmax(8rem,0.34fr)_minmax(0,1fr)]",
    );
    expect(input).toHaveAttribute("placeholder", "Enter worktree name");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancelName).toHaveBeenCalledOnce();
    await user.type(input, "feature/name");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.clear(input);
    await user.type(input, "feature-name");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmitName).toHaveBeenCalledWith("feature-name");
  });

  it("reuses the piggyback surface while preparing", () => {
    render(
      <WorkspaceSetupChoice
        state="creating"
        onCancelName={vi.fn()}
        onCreate={vi.fn()}
        onSubmitName={vi.fn()}
        onSkip={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Preparing your project workspace."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Your messages will send when it’s ready."),
    ).toBeInTheDocument();
  });
});
