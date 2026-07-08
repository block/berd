import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as gitApi from "@/shared/api/git";
import type { GitStateChangedPayload } from "@/shared/api/git";
import type { GitState } from "@/shared/types/git";
import { useChatSessionStore } from "../../stores/chatSessionStore";
import { useChatStore } from "../../stores/chatStore";
import { ContextPanel, ContextPanelWorktreeTracker } from "../ContextPanel";

const {
  mockUseGitState,
  mockRefetch,
  mockRefetchFiles,
  mockListDirectoryEntries,
  mockGetAllSessionArtifacts,
  mockEnsureDirectory,
  mockUpdateWorkingDir,
  mockOpenDialog,
  mockToastError,
  mockToastSuccess,
  mockListenGitStateChanged,
  gitStateChangedHandlers,
} = vi.hoisted(() => {
  const gitStateChangedHandlers: Array<
    (payload: GitStateChangedPayload) => void
  > = [];

  return {
    mockUseGitState: vi.fn(),
    mockRefetch: vi.fn(),
    mockRefetchFiles: vi.fn(),
    mockListDirectoryEntries: vi.fn(),
    mockGetAllSessionArtifacts: vi.fn(),
    mockEnsureDirectory: vi.fn(),
    mockUpdateWorkingDir: vi.fn(),
    mockOpenDialog: vi.fn(),
    mockToastError: vi.fn(),
    mockToastSuccess: vi.fn(),
    mockListenGitStateChanged: vi.fn(
      (handler: (payload: GitStateChangedPayload) => void) => {
        gitStateChangedHandlers.push(handler);
        return Promise.resolve(() => {});
      },
    ),
    gitStateChangedHandlers,
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: mockToastError,
    success: mockToastSuccess,
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
    dismiss: vi.fn(),
  },
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
  listenGitStateChanged: mockListenGitStateChanged,
}));

vi.mock("../../hooks/ArtifactPolicyContext", () => ({
  useArtifactActionsContext: () => ({
    openResolvedPath: vi.fn(),
    pathExists: () => Promise.resolve(true),
  }),
  useSessionArtifacts: () => mockGetAllSessionArtifacts(),
}));

describe("ContextPanel", () => {
  const getBranchButton = (branch: string) =>
    screen
      .getAllByRole("button")
      .find((button) => button.textContent?.startsWith(branch));
  const getButtonFromText = (text: string) => {
    const button =
      screen
        .getAllByText(text)
        .map((element) => element.closest("button"))
        .find(
          (candidate) => candidate && !candidate.getAttribute("aria-label"),
        ) ?? null;
    if (!button) throw new Error(`Missing button for ${text}`);
    return button;
  };
  const getWorkspaceActionsButton = () =>
    screen.getByRole("button", { name: /open project folder actions/i });
  const openWorkspaceActions = async (
    user: ReturnType<typeof userEvent.setup>,
  ) => {
    await user.click(getWorkspaceActionsButton());
  };
  const renderContextPanel = (
    props: Partial<Parameters<typeof ContextPanel>[0]> = {},
  ) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ContextPanel
          sessionId="test-session"
          projectWorkingDirs={["/Users/test/goose2"]}
          {...props}
        />
      </QueryClientProvider>,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    gitStateChangedHandlers.length = 0;
    window.localStorage.clear();
    mockRefetch.mockResolvedValue(undefined);
    mockRefetchFiles.mockResolvedValue(undefined);
    mockListDirectoryEntries.mockResolvedValue([]);
    mockEnsureDirectory.mockResolvedValue(undefined);
    mockUpdateWorkingDir.mockResolvedValue(undefined);
    mockOpenDialog.mockResolvedValue(null);
    mockGetAllSessionArtifacts.mockReturnValue([]);
    useChatStore.setState({ sessionStateById: {} });
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

  it("renders workspace context and supports switching to files tab", async () => {
    const user = userEvent.setup();

    renderContextPanel({
      sessionId: "test-session-1",
      projectName: "Desktop UX",
      projectColor: "#22c55e",
    });

    expect(screen.getByRole("tab", { name: /context/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /files/i })).toBeInTheDocument();
    expect(screen.getByText("Project")).toBeInTheDocument();
    expect(screen.getByText("Active worktree")).toBeInTheDocument();
    expect(screen.getByText("Desktop UX")).toBeInTheDocument();
    expect(screen.getAllByText("main").length).toBeGreaterThan(0);
    const changesSummary = screen.getAllByText((_, element) =>
      Boolean(element?.textContent?.includes("3 changes on main")),
    )[0];
    const changesCount = within(changesSummary).getByText("3");
    expect(changesSummary).toBeInTheDocument();
    expect(changesCount).toHaveClass("text-foreground");
    expect(changesCount.closest("section")).toHaveClass("pt-4");
    expect(changesCount.closest("section")).not.toHaveClass("pt-5");
    expect(
      screen.getByRole("button", { name: /select worktree/i }),
    ).toHaveTextContent("~/goose2");
    expect(
      screen.getByRole("button", { name: /select branch/i }),
    ).toHaveTextContent("main");

    await openWorkspaceActions(user);

    expect(
      screen.queryByRole("menuitem", { name: /refresh local status/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /^create branch$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /^fetch remote status$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /^pull$/i }),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("button", { name: /^create branch$/i }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /files/i }));

    expect(screen.getByText("goose2")).toBeInTheDocument();
  });

  it("matches chat composer horizontal padding in panel chrome", () => {
    renderContextPanel({
      sessionId: "test-session-padding",
      projectName: "Desktop UX",
    });

    const tabListFrame = screen.getByRole("tablist").parentElement;
    const contextTab = screen.getByRole("tab", { name: /context/i });
    const filesTab = screen.getByRole("tab", { name: /files/i });
    const divider = tabListFrame?.nextElementSibling;
    const workspaceSection = screen
      .getByText("Active worktree")
      .closest("section");
    const projectName = screen.getByText("Desktop UX");
    const workspaceSelector = screen.getByRole("button", {
      name: /select worktree/i,
    });
    const branchSelector = screen.getByRole("button", {
      name: /select branch/i,
    });
    const contextPadding = screen.getByRole("tabpanel", {
      name: /context/i,
    }).firstElementChild;

    expect(tabListFrame).toHaveClass("px-4");
    expect(tabListFrame).not.toHaveClass("px-5");
    expect(contextTab).toHaveClass("text-sm", "font-normal", "leading-normal");
    expect(filesTab).toHaveClass("text-sm", "font-normal", "leading-normal");
    expect(divider).toHaveClass("mx-4");
    expect(divider).not.toHaveClass("mx-5");
    expect(workspaceSection).toHaveClass("px-4");
    expect(workspaceSection).toHaveClass("pb-2", "pt-4");
    expect(workspaceSection).not.toHaveClass("pb-3", "pt-5");
    expect(workspaceSection).not.toHaveClass("px-5");
    expect(projectName.nextElementSibling).toBeNull();
    expect(workspaceSelector).toHaveTextContent("~/goose2");
    expect(branchSelector).toHaveTextContent("main");
    expect(contextPadding).toHaveClass("pb-4");
    expect(contextPadding).not.toHaveClass("pb-3");
  });

  it("uses the selected workspace as the files tab root", async () => {
    const user = userEvent.setup();
    useChatSessionStore
      .getState()
      .setActiveWorkspace("test-session-files-workspace", {
        path: "/Users/test/goose2-feature",
        branch: "feat/context-panel",
      });

    renderContextPanel({
      sessionId: "test-session-files-workspace",
      projectWorkingDirs: ["/Users/test/goose2"],
      sessionWorkingDir: "/Users/test/goose2",
    });

    await user.click(screen.getByRole("tab", { name: /files/i }));

    await waitFor(() => {
      expect(mockListDirectoryEntries).toHaveBeenCalledWith(
        "/Users/test/goose2-feature",
      );
    });
    expect(mockListDirectoryEntries).not.toHaveBeenCalledWith(
      "/Users/test/goose2",
    );
  });

  it("renders workspace controls in a flat non-collapsible layout", () => {
    renderContextPanel({
      sessionId: "test-session-collapse",
      projectName: "Desktop UX",
      projectColor: "#22c55e",
    });

    expect(
      screen.queryByRole("button", { name: /^workspace$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /select worktree/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /select branch/i }),
    ).toBeInTheDocument();
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
    expect(
      screen.getByRole("button", { name: /change folder/i }),
    ).toHaveTextContent("Working folder");
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
      expect(mockUpdateWorkingDir).toHaveBeenCalledWith(
        "test-session-artifact-folder",
        "/Users/test/custom artifacts",
      );
    });
    // The context panel re-points this chat only; the default folder for new
    // general chats is managed in Settings.
    expect(localStorage.getItem("goose:artifact-root-path")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /initialize git/i }),
    ).not.toBeInTheDocument();
  });

  it("changes the working folder from the workspace actions menu", async () => {
    const user = userEvent.setup();
    mockOpenDialog.mockResolvedValue("/Users/test/another-folder");

    renderContextPanel({
      sessionId: "test-session-git-change-folder",
      projectName: "Desktop UX",
    });

    await openWorkspaceActions(user);
    await user.click(screen.getByRole("menuitem", { name: /change folder/i }));

    expect(mockOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: "/Users/test/goose2",
        directory: true,
        multiple: false,
      }),
    );
    await waitFor(() => {
      expect(mockUpdateWorkingDir).toHaveBeenCalledWith(
        "test-session-git-change-folder",
        "/Users/test/another-folder",
      );
    });
    expect(localStorage.getItem("goose:artifact-root-path")).toBeNull();
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
      screen.getByRole("button", { name: /select worktree/i }),
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
      screen.getByRole("button", { name: /select worktree/i }),
    ).toHaveTextContent("~/goose2-feature");
    expect(
      screen.getByRole("button", { name: /select branch/i }),
    ).toHaveTextContent("feat/context-panel");
  });

  it("uses refreshed git state instead of a stale stored branch for the selected path", () => {
    useChatSessionStore
      .getState()
      .setActiveWorkspace("test-session-stale-branch", {
        path: "/Users/test/goose2",
        branch: "dev",
      });

    renderContextPanel({
      sessionId: "test-session-stale-branch",
      projectName: "Desktop UX",
    });

    expect(
      screen.getByRole("button", { name: /select worktree/i }),
    ).toHaveTextContent("~/goose2");
    expect(
      screen.getByRole("button", { name: /select branch/i }),
    ).toHaveTextContent("main");
    expect(
      screen.getByRole("button", { name: /select branch/i }),
    ).not.toHaveTextContent("dev");
  });

  it("selects the event-attributed worktree only for the session that just settled", async () => {
    let gitState: GitState = {
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
    };
    mockUseGitState.mockImplementation(() => ({
      data: gitState,
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mockRefetch,
    }));
    useChatStore
      .getState()
      .setChatState("test-session-new-worktree", "streaming");
    useChatStore
      .getState()
      .setStreamingMessageId("test-session-new-worktree", "message-1");

    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <ContextPanelWorktreeTracker
          sessionId="test-session-new-worktree"
          projectWorkingDirs={["/Users/test/goose2"]}
        />
        <ContextPanelWorktreeTracker
          sessionId="test-session-other-worktree"
          projectWorkingDirs={["/Users/test/goose2"]}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(gitStateChangedHandlers).toHaveLength(1);
    });
    act(() => {
      for (const handler of gitStateChangedHandlers) {
        handler({
          operation: "create_worktree",
          path: "/Users/test/goose2",
          affectedPaths: ["/Users/test/goose2-test2"],
          branch: "tulsi/test2",
        });
      }
    });

    gitState = {
      ...gitState,
      worktrees: [
        ...gitState.worktrees,
        {
          path: "/Users/test/goose2-test2",
          branch: "tulsi/test2",
          isMain: false,
        },
        {
          path: "/Users/test/goose2-unrelated",
          branch: "tulsi/unrelated",
          isMain: false,
        },
      ],
      localBranches: ["tulsi/test2", "tulsi/unrelated", "main"],
    };
    act(() => {
      useChatStore.getState().setChatState("test-session-new-worktree", "idle");
      useChatStore
        .getState()
        .setStreamingMessageId("test-session-new-worktree", null);
    });

    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ContextPanelWorktreeTracker
          sessionId="test-session-new-worktree"
          projectWorkingDirs={["/Users/test/goose2"]}
        />
        <ContextPanelWorktreeTracker
          sessionId="test-session-other-worktree"
          projectWorkingDirs={["/Users/test/goose2"]}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().activeWorkspaceBySession[
          "test-session-new-worktree"
        ],
      ).toEqual({
        path: "/Users/test/goose2-test2",
        branch: "tulsi/test2",
      });
    });
    expect(
      useChatSessionStore.getState().activeWorkspaceBySession[
        "test-session-other-worktree"
      ],
    ).toBeUndefined();
  });

  it("separates worktrees from available branch targets", async () => {
    const user = userEvent.setup();

    renderContextPanel({ sessionId: "test-session-4b" });

    await user.click(screen.getByRole("button", { name: /select worktree/i }));

    expect(screen.getByPlaceholderText("Search")).toBeInTheDocument();
    expect(getButtonFromText("goose2")).toHaveTextContent("~/goose2");
    expect(getButtonFromText("goose2-feature")).toHaveTextContent(
      "~/goose2-feature",
    );
    expect(getBranchButton("dev")).toBeUndefined();

    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /select branch/i }));

    expect(getBranchButton("feat/context-panel")).toBeDisabled();
    expect(getBranchButton("dev")).not.toBeDisabled();

    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /select worktree/i }));
    await user.click(getButtonFromText("goose2-feature"));

    expect(
      screen.getByRole("button", { name: /select worktree/i }),
    ).toHaveTextContent("~/goose2-feature");
    expect(
      screen.getByRole("button", { name: /select branch/i }),
    ).toHaveTextContent("feat/context-panel");
    expect(vi.mocked(gitApi.switchBranch)).not.toHaveBeenCalled();
  });

  it("routes available branch targets through the selected worktree", async () => {
    const user = userEvent.setup();

    let gitState: GitState = {
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
    };
    mockUseGitState.mockImplementation(() => ({
      data: gitState,
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mockRefetch,
    }));
    vi.mocked(gitApi.switchBranch).mockImplementationOnce(
      async (_path, branch) => {
        gitState = {
          ...gitState,
          currentBranch: branch,
          worktrees: gitState.worktrees.map((worktree) =>
            worktree.path === "/Users/test/goose2"
              ? { ...worktree, branch }
              : worktree,
          ),
        };
      },
    );

    renderContextPanel({
      sessionId: "test-session-4c",
      projectWorkingDirs: ["/Users/test/goose2-feature"],
    });

    await user.click(screen.getByRole("button", { name: /select branch/i }));

    expect(screen.getByPlaceholderText("Search")).toBeInTheDocument();
    expect(getBranchButton("main")).toBeDisabled();
    expect(getBranchButton("dev")).not.toBeDisabled();

    await user.click(screen.getByText("dev"));

    expect(vi.mocked(gitApi.switchBranch)).toHaveBeenCalledWith(
      "/Users/test/goose2-feature",
      "dev",
    );
    expect(
      screen.getByRole("button", { name: /select worktree/i }),
    ).toHaveTextContent("~/goose2-feature");
  });

  it("surfaces the real git error when a branch switch fails", async () => {
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
    // Tauri invoke rejects with the plain string from the Rust command.
    vi.mocked(gitApi.switchBranch).mockRejectedValueOnce(
      "git switch dev failed: fatal: 'dev' is already used by worktree at '/Users/test/elsewhere'",
    );

    renderContextPanel({
      sessionId: "test-session-switch-error",
      projectWorkingDirs: ["/Users/test/goose2-feature"],
    });

    await user.click(screen.getByRole("button", { name: /select branch/i }));

    expect(screen.getByPlaceholderText("Search")).toBeInTheDocument();
    expect(getBranchButton("main")).toBeDisabled();
    expect(getBranchButton("dev")).not.toBeDisabled();

    await user.click(screen.getByText("dev"));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        expect.stringContaining("already used by worktree"),
      );
    });
    // The picker stays on the real current context instead of pretending
    // the switch happened.
    expect(
      screen.getByRole("button", { name: /select branch/i }),
    ).toHaveTextContent("feat/context-panel");
  });

  it("keeps the workspace picker available when the selected workspace status fails", async () => {
    const user = userEvent.setup();
    useChatSessionStore
      .getState()
      .setActiveWorkspace("test-session-broken-workspace", {
        path: "/Users/test/goose2-broken",
        branch: "broken",
      });

    mockUseGitState.mockImplementation((path: string | null | undefined) => {
      if (path === "/Users/test/goose2-broken") {
        return {
          data: undefined,
          error: new Error("Git status is unavailable right now."),
          isLoading: false,
          isFetching: false,
          refetch: mockRefetch,
        };
      }

      return {
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
            {
              path: "/Users/test/goose2-broken",
              branch: "broken",
              isMain: false,
            },
          ],
          isWorktree: false,
          mainWorktreePath: "/Users/test/goose2",
          localBranches: ["main", "broken"],
        },
        error: null,
        isLoading: false,
        isFetching: false,
        refetch: mockRefetch,
      };
    });

    renderContextPanel({
      sessionId: "test-session-broken-workspace",
      projectWorkingDirs: ["/Users/test/goose2"],
      sessionWorkingDir: "/Users/test/goose2",
    });

    expect(
      screen.getByText("Git status is unavailable right now."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /select worktree/i }),
    ).toHaveTextContent("~/goose2-broken");
    expect(
      screen.getByRole("button", { name: /select branch/i }),
    ).toHaveTextContent("broken");

    await user.click(screen.getByRole("button", { name: /select worktree/i }));
    await user.click(getButtonFromText("goose2"));

    expect(
      useChatSessionStore.getState().activeWorkspaceBySession[
        "test-session-broken-workspace"
      ],
    ).toEqual({
      path: "/Users/test/goose2",
      branch: "main",
    });
  });

  it("tells the user their changes are stashed when the switch fails after stashing", async () => {
    const user = userEvent.setup();
    vi.mocked(gitApi.switchBranch).mockRejectedValueOnce(
      "git switch dev failed: fatal: something went wrong",
    );

    // Default state: main worktree with 3 dirty files, so picking an
    // untied branch routes through the stash-and-switch confirmation.
    renderContextPanel({ sessionId: "test-session-stash-fail" });

    await user.click(screen.getByRole("button", { name: /select branch/i }));
    await user.click(screen.getByText("dev"));
    await user.click(screen.getByRole("button", { name: /stash & switch/i }));

    expect(vi.mocked(gitApi.stashChanges)).toHaveBeenCalled();
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        expect.stringContaining("git stash pop"),
      );
    });
    expect(mockToastError).toHaveBeenCalledWith(
      expect.stringContaining("something went wrong"),
    );
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

    await user.click(screen.getByRole("button", { name: /select branch/i }));

    expect(screen.getByPlaceholderText("Search")).toBeInTheDocument();
    const currentBranchRow = screen
      .getAllByRole("button")
      .find(
        (button): button is HTMLButtonElement =>
          button instanceof HTMLButtonElement &&
          Boolean(button.textContent?.includes("main")) &&
          button.disabled,
      );
    if (!currentBranchRow) throw new Error("Missing current branch row");
    expect(currentBranchRow).toHaveTextContent("main");
    expect(currentBranchRow).toBeDisabled();
  });

  it("shows grouped workspace actions and create options", async () => {
    const user = userEvent.setup();

    renderContextPanel({
      sessionId: "test-session-6",
      onToggleTerminal: vi.fn(),
    });

    await openWorkspaceActions(user);

    expect(screen.queryByText("Local")).not.toBeInTheDocument();
    expect(screen.getAllByText("Project folders").length).toBeGreaterThan(0);
    expect(screen.getByText("Remote")).toBeInTheDocument();
    expect(screen.queryByText("Git")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /^refresh local status$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /^open terminal$/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /^create branch$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /^create worktree$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /^fetch remote status$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /^pull$/i }),
    ).toBeInTheDocument();
  });

  it("shows the incoming commit count on pull when available", async () => {
    const user = userEvent.setup();
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

    expect(screen.getByText("main")).toBeInTheDocument();

    await openWorkspaceActions(user);

    expect(
      screen.getByRole("menuitem", { name: /^pull 3 commits$/i }),
    ).toBeInTheDocument();
  });

  it("refreshes local status from the workspace header", async () => {
    const user = userEvent.setup();
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");

    renderContextPanel({ sessionId: "test-session-refresh-git-status" });

    await user.click(
      screen.getByRole("button", { name: /refresh local status/i }),
    );

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["git-state"] });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["changed-files"],
      });
    });
  });

  it("creates a branch from the branch selector dialog", async () => {
    const user = userEvent.setup();

    let gitState: GitState = {
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
    };
    mockUseGitState.mockImplementation(() => ({
      data: gitState,
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mockRefetch,
    }));
    vi.mocked(gitApi.createBranch).mockImplementationOnce(
      async (_path, name) => {
        gitState = {
          ...gitState,
          currentBranch: name,
          localBranches: [...gitState.localBranches, name],
          worktrees: gitState.worktrees.map((worktree) =>
            worktree.path === "/Users/test/goose2"
              ? { ...worktree, branch: name }
              : worktree,
          ),
        };
      },
    );

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
    expect(screen.getAllByText("feature/new-branch").length).toBeGreaterThan(0);
  });

  it("creates a worktree from the workspace actions dialog", async () => {
    const user = userEvent.setup();

    vi.mocked(gitApi.createWorktree).mockResolvedValue({
      path: "/Users/test/goose2-worktrees/new-worktree",
      branch: "feature/new-worktree",
    });

    renderContextPanel({ sessionId: "test-session-8" });

    await openWorkspaceActions(user);
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
      screen.getByRole("button", { name: /select worktree/i }),
    ).toHaveTextContent("~/goose2-worktrees/new-worktree");
    expect(
      screen.getByRole("button", { name: /select branch/i }),
    ).toHaveTextContent("feature/new-worktree");
  });

  it("does not create a worktree from an unborn branch ref", async () => {
    const user = userEvent.setup();
    mockUseGitState.mockReturnValue({
      data: {
        isGitRepo: true,
        currentBranch: "main",
        dirtyFileCount: 0,
        incomingCommitCount: 0,
        worktrees: [
          {
            path: "/Users/test/goose-artifacts",
            branch: null,
            isMain: true,
          },
        ],
        isWorktree: false,
        mainWorktreePath: "/Users/test/goose-artifacts",
        localBranches: [],
      },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mockRefetch,
    });

    renderContextPanel({
      sessionId: "test-session-unborn-worktree",
      projectWorkingDirs: ["/Users/test/goose-artifacts"],
    });

    await openWorkspaceActions(user);
    await user.click(
      screen.getByRole("menuitem", { name: /^create worktree$/i }),
    );
    await user.type(screen.getByLabelText("Worktree name"), "new-worktree");

    expect(screen.getAllByText("No branches available").length).toBeGreaterThan(
      0,
    );
    expect(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /^create worktree$/i,
      }),
    ).toBeDisabled();
    expect(vi.mocked(gitApi.createWorktree)).not.toHaveBeenCalled();
  });

  it("opens create worktree from the workspace actions menu", async () => {
    const user = userEvent.setup();

    renderContextPanel({ sessionId: "test-session-8b" });

    await openWorkspaceActions(user);
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

    await openWorkspaceActions(user);
    await user.click(
      screen.getByRole("menuitem", { name: /^create worktree$/i }),
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

    await openWorkspaceActions(user);
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
