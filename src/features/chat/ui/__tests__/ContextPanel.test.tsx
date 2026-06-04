import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as gitApi from "@/shared/api/git";
import { ContextPanel } from "../ContextPanel";

const {
  mockUseGitState,
  mockRefetch,
  mockRefetchFiles,
  mockListDirectoryEntries,
  mockGetAllSessionArtifacts,
  mockEnsureDirectory,
  mockUpdateWorkingDir,
  mockOpenDialog,
} = vi.hoisted(() => ({
  mockUseGitState: vi.fn(),
  mockRefetch: vi.fn(),
  mockRefetchFiles: vi.fn(),
  mockListDirectoryEntries: vi.fn(),
  mockGetAllSessionArtifacts: vi.fn(),
  mockEnsureDirectory: vi.fn(),
  mockUpdateWorkingDir: vi.fn(),
  mockOpenDialog: vi.fn(),
}));

vi.mock("@/shared/hooks/useGitState", () => ({
  useGitState: (...args: unknown[]) => mockUseGitState(...args),
}));

vi.mock("@/shared/hooks/useChangedFiles", () => ({
  useChangedFiles: () => ({
    data: [],
    isLoading: false,
    refetch: mockRefetchFiles,
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

vi.mock("@/shared/api/system", () => ({
  listDirectoryEntries: mockListDirectoryEntries,
  ensureDirectory: mockEnsureDirectory,
}));

vi.mock("@/shared/api/acpApi", () => ({
  updateWorkingDir: mockUpdateWorkingDir,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mockOpenDialog,
}));

vi.mock("@/shared/api/git", () => ({
  createBranch: vi.fn(),
  createWorktree: vi.fn(),
  fetchRepo: vi.fn(),
  pullRepo: vi.fn(),
  switchBranch: vi.fn(),
  stashChanges: vi.fn(),
  initRepo: vi.fn(),
}));

vi.mock("../../hooks/ArtifactPolicyContext", () => ({
  useArtifactPolicyContext: () => ({
    getAllSessionArtifacts: mockGetAllSessionArtifacts,
    openResolvedPath: vi.fn(),
    pathExists: () => Promise.resolve(true),
  }),
}));

describe("ContextPanel", () => {
  const getBranchButton = (branch: string) =>
    screen
      .getAllByRole("button")
      .find((button) => button.textContent?.startsWith(branch));
  const getCreateActionMenuButton = () =>
    screen.getByRole("button", { name: /choose create action/i });
  const renderContextPanel = (
    props: Partial<Parameters<typeof ContextPanel>[0]> = {},
  ) =>
    render(
      <ContextPanel
        sessionId="test-session"
        projectWorkingDirs={["/Users/test/goose2"]}
        {...props}
      />,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockRefetch.mockResolvedValue(undefined);
    mockRefetchFiles.mockResolvedValue(undefined);
    mockListDirectoryEntries.mockResolvedValue([]);
    mockEnsureDirectory.mockResolvedValue(undefined);
    mockUpdateWorkingDir.mockResolvedValue(undefined);
    mockOpenDialog.mockResolvedValue(null);
    mockGetAllSessionArtifacts.mockReturnValue([]);
    vi.mocked(gitApi.createWorktree).mockResolvedValue({
      path: "/Users/test/goose2-worktrees/new-worktree",
      branch: "new-worktree",
    });
    mockUseGitState.mockReturnValue({
      data: {
        isGitRepo: true,
        currentBranch: "main",
        dirtyFileCount: 3,
        incomingCommitCount: 0,
        worktrees: [
          {
            path: "/Users/test/goose2",
            branch: "main",
            isMain: true,
          },
          {
            path: "/Users/test/goose2-feature",
            branch: "feat/context-panel",
            isMain: false,
          },
        ],
        isWorktree: false,
        mainWorktreePath: "/Users/test/goose2",
        localBranches: ["main", "feat/context-panel", "dev", "old-feature"],
      },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mockRefetch,
    });
  });

  it("renders workspace details and supports switching to files tab", async () => {
    const user = userEvent.setup();

    renderContextPanel({
      sessionId: "test-session-1",
      projectName: "Desktop UX",
      projectColor: "#22c55e",
    });

    expect(screen.getByRole("tab", { name: /details/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /files/i })).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Desktop UX")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /select worktree or branch/i }),
    ).toHaveTextContent("~/goose2");
    expect(
      screen.getByRole("button", { name: /select worktree or branch/i }),
    ).toHaveTextContent("main");
    expect(screen.queryByText("3 uncommitted changes")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^create branch$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^fetch$/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^pull$/i })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /files/i }));

    expect(screen.getByText("goose2")).toBeInTheDocument();
  });

  it("collapses and expands context panel sections", async () => {
    const user = userEvent.setup();

    renderContextPanel({
      sessionId: "test-session-collapse",
      projectName: "Desktop UX",
      projectColor: "#22c55e",
    });

    await user.click(screen.getByRole("button", { name: /workspace/i }));

    expect(screen.queryByText("Desktop UX")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /workspace/i }));

    expect(screen.getByText("Desktop UX")).toBeInTheDocument();
  });

  it("shows path and init button for non-git directory", async () => {
    const user = userEvent.setup();
    const onToggleTerminal = vi.fn();
    mockUseGitState.mockReturnValue({
      data: {
        isGitRepo: false,
        currentBranch: null,
        dirtyFileCount: 0,
        incomingCommitCount: 0,
        worktrees: [],
        isWorktree: false,
        mainWorktreePath: null,
        localBranches: [],
      },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mockRefetch,
    });

    renderContextPanel({
      sessionId: "test-session-2",
      projectWorkingDirs: ["/Users/test/not-a-repo"],
      onToggleTerminal,
    });

    await user.click(screen.getByRole("button", { name: /open terminal/i }));

    expect(onToggleTerminal).toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /initialize git/i }),
    ).toBeInTheDocument();
  });

  it("shows artifact folder controls for no-project non-git chats", async () => {
    const user = userEvent.setup();
    const onToggleTerminal = vi.fn();
    mockOpenDialog.mockResolvedValue("/Users/test/custom artifacts");
    mockUseGitState.mockReturnValue({
      data: {
        isGitRepo: false,
        currentBranch: null,
        dirtyFileCount: 0,
        incomingCommitCount: 0,
        worktrees: [],
        isWorktree: false,
        mainWorktreePath: null,
        localBranches: [],
      },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mockRefetch,
    });

    renderContextPanel({
      sessionId: "test-session-artifact-folder",
      projectWorkingDirs: [],
      sessionWorkingDir: "/Users/test/goose artifacts",
      onToggleTerminal,
    });

    expect(screen.getByText("General chat")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /open terminal/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /change folder/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /change folder/i }),
    ).toHaveTextContent("Artifact folder");
    expect(
      screen.getByRole("button", { name: /change folder/i }),
    ).toHaveTextContent("goose artifacts");

    await user.click(screen.getByRole("button", { name: /change folder/i }));

    expect(mockOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: "/Users/test/goose artifacts",
        directory: true,
        multiple: false,
      }),
    );
    await waitFor(() => {
      expect(localStorage.getItem("goose:artifact-root-path")).toBe(
        "/Users/test/custom artifacts",
      );
    });
    expect(
      screen.queryByRole("button", { name: /initialize git/i }),
    ).not.toBeInTheDocument();
  });

  it("does not show session artifacts for git-backed chats", () => {
    mockGetAllSessionArtifacts.mockReturnValue([
      {
        resolvedPath: "/Users/test/goose2/src/App.tsx",
        displayPath: "/Users/test/goose2/src/App.tsx",
        filename: "App.tsx",
        directoryPath: "/Users/test/goose2/src/",
        resolvedDirectoryPath: "/Users/test/goose2/src/",
        versionCount: 1,
        lastTouchedAt: Date.now(),
        kind: "file",
        toolName: "edit_file",
        toolKind: "edit",
      },
    ]);

    renderContextPanel({
      sessionId: "test-session-git-artifacts-hidden",
      projectName: "Desktop UX",
    });

    expect(screen.queryByText("Artifacts")).not.toBeInTheDocument();
    expect(screen.queryByText("App.tsx")).not.toBeInTheDocument();
  });

  it("shows session artifacts for non-git chats", () => {
    mockUseGitState.mockReturnValue({
      data: {
        isGitRepo: false,
        currentBranch: null,
        dirtyFileCount: 0,
        incomingCommitCount: 0,
        worktrees: [],
        isWorktree: false,
        mainWorktreePath: null,
        localBranches: [],
      },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mockRefetch,
    });
    mockGetAllSessionArtifacts.mockReturnValue([
      {
        resolvedPath: "/Users/test/report.md",
        displayPath: "/Users/test/report.md",
        filename: "report.md",
        directoryPath: "/Users/test/",
        resolvedDirectoryPath: "/Users/test/",
        versionCount: 1,
        lastTouchedAt: Date.now(),
        kind: "file",
        toolName: "write_file",
        toolKind: "edit",
      },
    ]);

    renderContextPanel({
      sessionId: "test-session-non-git-artifacts-visible",
      projectWorkingDirs: ["/Users/test"],
    });

    expect(screen.getByText("Artifacts")).toBeInTheDocument();
    expect(screen.getByText("report.md")).toBeInTheDocument();
  });

  it("shows the working context picker when git repo is available", () => {
    renderContextPanel({
      sessionId: "test-session-3",
      projectName: "Desktop UX",
    });

    expect(
      screen.getByRole("button", { name: /select worktree or branch/i }),
    ).toBeInTheDocument();
  });

  it("defaults to the current worktree path instead of the first worktree", () => {
    mockUseGitState.mockReturnValue({
      data: {
        isGitRepo: true,
        currentBranch: "feat/context-panel",
        dirtyFileCount: 0,
        incomingCommitCount: 0,
        worktrees: [
          {
            path: "/Users/test/goose2",
            branch: "main",
            isMain: true,
          },
          {
            path: "/Users/test/goose2-feature",
            branch: "feat/context-panel",
            isMain: false,
          },
        ],
        isWorktree: true,
        mainWorktreePath: "/Users/test/goose2",
        localBranches: ["feat/context-panel", "main", "dev"],
      },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mockRefetch,
    });

    renderContextPanel({
      sessionId: "test-session-4",
      projectWorkingDirs: ["/Users/test/goose2-feature"],
    });

    expect(
      screen.getByRole("button", { name: /select worktree or branch/i }),
    ).toHaveTextContent("~/goose2-feature");
    expect(
      screen.getByRole("button", { name: /select worktree or branch/i }),
    ).toHaveTextContent("feat/context-panel");
  });

  it("shows all branches on the main worktree and uses folder subtext for branch targets", async () => {
    const user = userEvent.setup();

    renderContextPanel({ sessionId: "test-session-4b" });

    await user.click(
      screen.getByRole("button", { name: /select worktree or branch/i }),
    );

    expect(screen.getByText("All branches")).toBeInTheDocument();
    expect(screen.getByText("Current branch").closest("button")).toBeDisabled();
    expect(getBranchButton("feat/context-panel")).toHaveTextContent(
      "~/goose2-feature",
    );
    expect(getBranchButton("dev")).toHaveTextContent("~/goose2");
    expect(getBranchButton("dev")).not.toBeDisabled();

    const featureBranchButton = getBranchButton("feat/context-panel");
    if (!featureBranchButton) throw new Error("Missing feature branch button");
    await user.click(featureBranchButton);

    expect(
      screen.getByRole("button", { name: /select worktree or branch/i }),
    ).toHaveTextContent("~/goose2-feature");
    expect(
      screen.getByRole("button", { name: /select worktree or branch/i }),
    ).toHaveTextContent("feat/context-panel");
    expect(vi.mocked(gitApi.switchBranch)).not.toHaveBeenCalled();
  });

  it("shows all branches on non-main worktrees and routes untied branches through main", async () => {
    const user = userEvent.setup();

    mockUseGitState.mockReturnValue({
      data: {
        isGitRepo: true,
        currentBranch: "feat/context-panel",
        dirtyFileCount: 0,
        incomingCommitCount: 0,
        worktrees: [
          {
            path: "/Users/test/goose2",
            branch: "main",
            isMain: true,
          },
          {
            path: "/Users/test/goose2-feature",
            branch: "feat/context-panel",
            isMain: false,
          },
        ],
        isWorktree: true,
        mainWorktreePath: "/Users/test/goose2",
        localBranches: ["feat/context-panel", "main", "dev"],
      },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mockRefetch,
    });

    renderContextPanel({
      sessionId: "test-session-4c",
      projectWorkingDirs: ["/Users/test/goose2-feature"],
    });

    await user.click(
      screen.getByRole("button", { name: /select worktree or branch/i }),
    );

    expect(screen.getByText("All branches")).toBeInTheDocument();
    expect(getBranchButton("main")).toHaveTextContent("~/goose2");
    expect(getBranchButton("dev")).toHaveTextContent("~/goose2");

    await user.click(screen.getByText("dev"));

    expect(vi.mocked(gitApi.switchBranch)).toHaveBeenCalledWith(
      "/Users/test/goose2",
      "dev",
    );
    expect(
      screen.getByRole("button", { name: /select worktree or branch/i }),
    ).toHaveTextContent("~/goose2");
    expect(
      screen.getByRole("button", { name: /select worktree or branch/i }),
    ).toHaveTextContent("dev");
  });

  it("shows the current branch in the picker when it is the only option", async () => {
    const user = userEvent.setup();

    mockUseGitState.mockReturnValue({
      data: {
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
        localBranches: ["main"],
      },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mockRefetch,
    });

    renderContextPanel({ sessionId: "test-session-5" });

    await user.click(
      screen.getByRole("button", { name: /select worktree or branch/i }),
    );

    expect(screen.getByText("Worktrees")).toBeInTheDocument();
    expect(screen.getByText("goose2")).toBeInTheDocument();
    expect(screen.getAllByText("main")[0]).toBeInTheDocument();
  });

  it("shows inline workspace actions and create options", async () => {
    const user = userEvent.setup();

    renderContextPanel({ sessionId: "test-session-6" });

    expect(
      screen.getByRole("button", { name: /^create branch$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^fetch$/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^pull$/i })).toBeInTheDocument();

    await user.click(getCreateActionMenuButton());

    expect(
      screen.getByRole("menuitem", { name: /^create branch$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /^create worktree$/i }),
    ).toBeInTheDocument();
  });

  it("shows the incoming commit count on pull when available", () => {
    mockUseGitState.mockReturnValue({
      data: {
        isGitRepo: true,
        currentBranch: "main",
        dirtyFileCount: 0,
        incomingCommitCount: 3,
        worktrees: [
          {
            path: "/Users/test/goose2",
            branch: "main",
            isMain: true,
          },
        ],
        isWorktree: false,
        mainWorktreePath: "/Users/test/goose2",
        localBranches: ["main"],
      },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mockRefetch,
    });

    renderContextPanel({ sessionId: "test-session-6b" });

    expect(
      screen.getByRole("button", { name: /^pull \(3\)$/i }),
    ).toBeInTheDocument();
  });

  it("creates a branch from the workspace actions dialog", async () => {
    const user = userEvent.setup();

    renderContextPanel({ sessionId: "test-session-7" });

    await user.click(screen.getByRole("button", { name: /^create branch$/i }));
    await user.type(screen.getByLabelText("Branch name"), "feature/new-branch");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /^create branch$/i,
      }),
    );

    expect(vi.mocked(gitApi.createBranch)).toHaveBeenCalledWith(
      "/Users/test/goose2",
      "feature/new-branch",
      "main",
    );
    expect(
      screen.getByRole("button", { name: /select worktree or branch/i }),
    ).toHaveTextContent("feature/new-branch");
  });

  it("creates a worktree from the workspace actions dialog", async () => {
    const user = userEvent.setup();

    vi.mocked(gitApi.createWorktree).mockResolvedValue({
      path: "/Users/test/goose2-worktrees/new-worktree",
      branch: "feature/new-worktree",
    });

    renderContextPanel({ sessionId: "test-session-8" });

    await user.click(getCreateActionMenuButton());
    await user.click(
      screen.getByRole("menuitem", { name: /^create worktree$/i }),
    );
    expect(
      within(screen.getByRole("dialog")).getByRole("heading", {
        name: /new worktree/i,
      }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("Worktree name"), "new-worktree");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /^create worktree$/i,
      }),
    );

    expect(vi.mocked(gitApi.createWorktree)).toHaveBeenCalledWith(
      "/Users/test/goose2",
      "new-worktree",
      "new-worktree",
      true,
      "main",
    );
    expect(
      screen.getByRole("button", { name: /select worktree or branch/i }),
    ).toHaveTextContent("~/goose2-worktrees/new-worktree");
    expect(
      screen.getByRole("button", { name: /select worktree or branch/i }),
    ).toHaveTextContent("new-worktree");
  });

  it("remembers the last selected create action on the primary button", async () => {
    const user = userEvent.setup();

    renderContextPanel({ sessionId: "test-session-8b" });

    await user.click(getCreateActionMenuButton());
    await user.click(
      screen.getByRole("menuitem", { name: /^create worktree$/i }),
    );

    expect(
      within(screen.getByRole("dialog")).getByRole("heading", {
        name: /new worktree/i,
      }),
    ).toBeInTheDocument();

    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /^cancel$/i,
      }),
    );

    expect(
      screen.getByRole("button", { name: /^create worktree$/i }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /^create worktree$/i }),
    );

    expect(
      within(screen.getByRole("dialog")).getByRole("heading", {
        name: /new worktree/i,
      }),
    ).toBeInTheDocument();
  });

  it("syncs worktree name into branch name until branch name is edited manually", async () => {
    const user = userEvent.setup();

    renderContextPanel({ sessionId: "test-session-9" });

    await user.click(getCreateActionMenuButton());
    await user.click(
      screen.getByRole("menuitem", { name: /^create worktree$/i }),
    );

    const worktreeNameInput = screen.getByLabelText("Worktree name");
    const branchNameInput = screen.getByLabelText("Branch name");

    await user.type(worktreeNameInput, "demo");
    expect(branchNameInput).toHaveValue("demo");

    await user.clear(branchNameInput);
    await user.type(branchNameInput, "custom-branch");
    await user.type(worktreeNameInput, "-next");

    expect(worktreeNameInput).toHaveValue("demo-next");
    expect(branchNameInput).toHaveValue("custom-branch");
  });
});
