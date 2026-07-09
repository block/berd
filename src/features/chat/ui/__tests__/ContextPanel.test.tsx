import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as gitApi from "@/shared/api/git";
import type { GitStateChangedPayload } from "@/shared/api/git";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import type { GitState } from "@/shared/types/git";
import {
  enrichWorkspaceAttachmentWithGitState,
  workspaceAttachmentIdForPath,
} from "@/features/chat/lib/workspaceAttachments";
import { useChatSessionStore } from "../../stores/chatSessionStore";
import { useChatStore } from "../../stores/chatStore";
import { getWorkspaceGitContext } from "../widgets/WorkspaceIdentity";
import { ContextPanel, ContextPanelWorktreeTracker } from "../ContextPanel";

const {
  mockUseGitState,
  mockUseWorkspaceGitRuntimes,
  mockUseWorkspaceChangedFilesRuntimes,
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
    mockUseWorkspaceGitRuntimes: vi.fn(),
    mockUseWorkspaceChangedFilesRuntimes: vi.fn(),
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

vi.mock("../hooks/useWorkspaceGitRuntimes", () => ({
  useWorkspaceGitRuntimes: (...args: unknown[]) =>
    mockUseWorkspaceGitRuntimes(...args),
  useWorkspaceChangedFilesRuntimes: (...args: unknown[]) =>
    mockUseWorkspaceChangedFilesRuntimes(...args),
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
  deleteBranch: vi.fn(),
  fetchRepo: vi.fn(),
  getGitState: vi.fn(),
  pullRepo: vi.fn(),
  removeWorktree: vi.fn(),
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
  const DEFAULT_PROJECT_WORKING_DIRS = ["/Users/test/goose2"];
  const getAddWorkspaceButton = () =>
    screen.getByRole("button", { name: /^add a workspace$/i });
  const getWorkspaceSectionActionsMenuButton = () =>
    screen.getByRole("button", {
      name: /open actions for workspace/i,
    });
  const getWorkspaceActionsMenuButton = (name: RegExp | string = /goose2/i) =>
    screen.getByRole("button", {
      name:
        name instanceof RegExp
          ? new RegExp(`open actions for .*${name.source}`, "i")
          : new RegExp(`open actions for .*${name}`, "i"),
    });
  const openWorkspaceActionsMenu = async (
    user: ReturnType<typeof userEvent.setup>,
    name?: RegExp | string,
  ) => {
    await user.click(getWorkspaceActionsMenuButton(name));
  };
  const openAddWorkspaceDialog = async (
    user: ReturnType<typeof userEvent.setup>,
  ) => {
    const addWorkspaceButton = screen.queryByRole("button", {
      name: /^add a workspace$/i,
    });
    if (addWorkspaceButton) {
      await user.click(addWorkspaceButton);
    } else {
      await user.click(getWorkspaceSectionActionsMenuButton());
      await user.click(
        screen.getByRole("menuitem", { name: /^add a workspace$/i }),
      );
    }
    return screen.findByRole("dialog", { name: /add workspace/i });
  };
  const selectWorkspaceStart = async (
    user: ReturnType<typeof userEvent.setup>,
    name: RegExp,
  ) => {
    await user.click(screen.getByRole("combobox", { name: /local repo/i }));
    await user.click(await screen.findByRole("option", { name }));
  };
  const chooseWorkspaceDirectory = async (
    user: ReturnType<typeof userEvent.setup>,
    dialog: HTMLElement,
  ) => {
    await user.click(
      within(dialog).getByRole("button", { name: /add another workspace/i }),
    );
  };
  const clickAddWorkspace = async (
    user: ReturnType<typeof userEvent.setup>,
    dialog: HTMLElement,
  ) => {
    await user.click(within(dialog).getByRole("button", { name: /^add$/i }));
  };
  const enableCreateWorktree = async (
    user: ReturnType<typeof userEvent.setup>,
    dialog: HTMLElement,
  ) => {
    await user.click(
      within(dialog).getByRole("checkbox", { name: /create worktree/i }),
    );
  };
  const materializedWorkspace = (path: string): WorkspaceAttachment => ({
    id: workspaceAttachmentIdForPath(path),
    path,
    kind: "directory",
    source: "inferred",
    branch: null,
    usedByAgent: false,
  });
  const ensurePanelSession = (
    sessionId: string,
    workingDirs: string[],
    sessionWorkingDir?: string | null,
  ) => {
    const store = useChatSessionStore.getState();
    if (store.sessions.some((session) => session.id === sessionId)) {
      return;
    }

    const workingDir = sessionWorkingDir ?? workingDirs[0];
    if (!workingDir) {
      return;
    }

    useChatSessionStore.setState((state) => ({
      sessions: [
        {
          id: sessionId,
          title: "Chat",
          workingDir,
          workspaceAttachments: workingDirs.map(materializedWorkspace),
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
        ...state.sessions,
      ],
    }));
  };
  const renderContextPanel = (
    props: Partial<Parameters<typeof ContextPanel>[0]> = {},
  ) => {
    const sessionId = props.sessionId ?? "test-session";
    const projectWorkingDirs =
      props.projectWorkingDirs ?? DEFAULT_PROJECT_WORKING_DIRS;
    ensurePanelSession(sessionId, projectWorkingDirs, props.sessionWorkingDir);

    return render(
      <QueryClientProvider client={new QueryClient()}>
        <ContextPanel
          {...props}
          sessionId={sessionId}
          projectWorkingDirs={projectWorkingDirs}
        />
      </QueryClientProvider>,
    );
  };
  const gitProbePathForWorkspace = (workspace: WorkspaceAttachment) =>
    (
      workspace.worktreePath ??
      workspace.repositoryPath ??
      workspace.path
    ).replace(/\/+$/, "");
  const createWorkspaceRuntime = (
    workspace: WorkspaceAttachment,
    gitState: GitState | undefined,
    overrides: {
      error?: Error | null;
      isLoading?: boolean;
      isFetching?: boolean;
    } = {},
  ) => {
    const enrichedWorkspace = enrichWorkspaceAttachmentWithGitState(
      workspace,
      gitState,
    );
    return {
      workspace: enrichedWorkspace,
      originalWorkspace: workspace,
      gitProbePath: gitProbePathForWorkspace(workspace),
      gitState,
      gitContext: getWorkspaceGitContext(enrichedWorkspace, gitState),
      isLoading: overrides.isLoading ?? false,
      isFetching: overrides.isFetching ?? false,
      error: overrides.error ?? null,
      refetch: mockRefetch,
    };
  };
  const createManagedWorktreeAttachment = (
    path: string,
    worktreePath: string,
    overrides: Partial<WorkspaceAttachment> = {},
  ): WorkspaceAttachment => ({
    id: workspaceAttachmentIdForPath(path),
    path,
    kind: "subdirectory",
    source: "created",
    branch: "feat/context-panel",
    repositoryPath: "/Users/test/goose2",
    worktreePath,
    lifecycle: {
      owner: "goose",
      cleanup: "worktree",
      branch: "feat/context-panel",
      baseBranch: "main",
      repositoryPath: "/Users/test/goose2",
      worktreePath,
      createdBranch: true,
    },
    usedByAgent: false,
    ...overrides,
  });
  const ensurePointerCaptureMethods = () => {
    if (!Element.prototype.hasPointerCapture) {
      Object.defineProperty(Element.prototype, "hasPointerCapture", {
        configurable: true,
        value: () => false,
      });
    }
    if (!Element.prototype.setPointerCapture) {
      Object.defineProperty(Element.prototype, "setPointerCapture", {
        configurable: true,
        value: () => undefined,
      });
    }
    if (!Element.prototype.releasePointerCapture) {
      Object.defineProperty(Element.prototype, "releasePointerCapture", {
        configurable: true,
        value: () => undefined,
      });
    }
    if (!Element.prototype.scrollIntoView) {
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        value: () => undefined,
      });
    }
  };

  beforeEach(() => {
    ensurePointerCaptureMethods();
    vi.clearAllMocks();
    gitStateChangedHandlers.length = 0;
    window.localStorage.clear();
    useChatStore.setState({ sessionStateById: {} });
    useChatSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      isLoadingMoreSessions: false,
      hasHydratedSessions: true,
      sessionPageCursor: null,
      hasMoreSessions: false,
      isContextPanelOpen: false,
      activeWorkspaceBySession: {},
      modelSelectionIntentBySession: {},
    });
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
    vi.mocked(gitApi.deleteBranch).mockResolvedValue(undefined);
    vi.mocked(gitApi.removeWorktree).mockResolvedValue(undefined);
    vi.mocked(gitApi.getGitState).mockResolvedValue({
      isGitRepo: true,
      currentBranch: "main",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [
        {
          path: "/Users/test/builderbot",
          branch: "main",
          isMain: true,
        },
        {
          path: "/Users/test/builderbot-feature",
          branch: "feat/chat-worktrees",
          isMain: false,
        },
      ],
      isWorktree: false,
      mainWorktreePath: "/Users/test/builderbot",
      localBranches: ["main", "dev"],
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
    mockUseWorkspaceGitRuntimes.mockImplementation(
      (workspaces: WorkspaceAttachment[]) => {
        const queryResult = mockUseGitState();
        return workspaces.map((workspace) =>
          createWorkspaceRuntime(workspace, queryResult.data),
        );
      },
    );
    mockUseWorkspaceChangedFilesRuntimes.mockReturnValue([]);
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

  it("renders included workspaces and workspace actions", async () => {
    const user = userEvent.setup();

    renderContextPanel({
      sessionId: "test-session-1",
      projectName: "Desktop UX",
      projectColor: "#22c55e",
    });

    expect(screen.getByRole("tab", { name: /context/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /files/i })).toBeInTheDocument();
    expect(screen.getByText("Project")).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Desktop UX")).toBeInTheDocument();
    expect(screen.getByText("goose2")).toBeInTheDocument();
    expect(screen.getByText("main checkout")).toBeInTheDocument();
    expect(screen.queryByText("Main worktree")).not.toBeInTheDocument();
    expect(screen.queryByText("3 changed")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /select worktree or branch/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /change folder/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^add a workspace$/i }),
    ).not.toBeInTheDocument();
    expect(getWorkspaceSectionActionsMenuButton()).toBeInTheDocument();
    expect(getWorkspaceActionsMenuButton()).toBeInTheDocument();

    await openWorkspaceActionsMenu(user);

    expect(
      screen.queryByRole("menuitem", { name: /^copy path$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /^create branch$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /^create worktree$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /^remove from chat$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /fetch remote status/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /^pull$/i }),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("tab", { name: /files/i }));

    expect(screen.getByText("goose2")).toBeInTheDocument();
  });

  it("renders repo-relative titles for project subdirectories", () => {
    mockUseGitState.mockReturnValue({
      data: {
        isGitRepo: true,
        currentBranch: "main",
        dirtyFileCount: 3,
        incomingCommitCount: 0,
        worktrees: [
          {
            path: "/Users/test/cash-server",
            branch: "main",
            isMain: true,
          },
        ],
        isWorktree: false,
        mainWorktreePath: "/Users/test/cash-server",
        localBranches: ["main"],
      },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mockRefetch,
    });

    renderContextPanel({
      sessionId: "test-session-project-subdir",
      projectName: "Builderbot",
      projectWorkingDirs: ["/Users/test/cash-server/builderbot"],
    });

    expect(screen.getByText("cash-server/builderbot")).toBeInTheDocument();
    expect(screen.getByText("main checkout")).toBeInTheDocument();
    expect(screen.queryByText("Subdirectory")).not.toBeInTheDocument();
    expect(screen.queryByText("../builderbot")).not.toBeInTheDocument();
  });

  it("renders linked worktree names for project subdirectories in worktrees", () => {
    mockUseGitState.mockReturnValue({
      data: {
        isGitRepo: true,
        currentBranch: "feature/chat-workspaces",
        dirtyFileCount: 0,
        incomingCommitCount: 0,
        worktrees: [
          {
            path: "/Users/test/cash-server",
            branch: "main",
            isMain: true,
          },
          {
            path: "/Users/test/cash-server-worktrees/chat-workspaces",
            branch: "feature/chat-workspaces",
            isMain: false,
          },
        ],
        isWorktree: true,
        mainWorktreePath: "/Users/test/cash-server",
        localBranches: ["main", "feature/chat-workspaces"],
      },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mockRefetch,
    });

    renderContextPanel({
      sessionId: "test-session-project-worktree-subdir",
      projectName: "Builderbot",
      projectWorkingDirs: [
        "/Users/test/cash-server-worktrees/chat-workspaces/builderbot",
      ],
    });

    expect(screen.getByText("cash-server/builderbot")).toBeInTheDocument();
    expect(screen.getByText("chat-workspaces")).toBeInTheDocument();
    expect(screen.queryByText("../builderbot")).not.toBeInTheDocument();
  });

  it("does not render original project paths for worktree startup sessions", () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-worktree-startup-plan",
          title: "Chat",
          workingDir: "/Users/test/goose2-worktrees/chat-123/builderbot",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath(
                "/Users/test/goose2-worktrees/chat-123/builderbot",
              ),
              path: "/Users/test/goose2-worktrees/chat-123/builderbot",
              kind: "subdirectory",
              source: "created",
              branch: "chat-123",
              repositoryPath: "/Users/test/goose2",
              worktreePath: "/Users/test/goose2-worktrees/chat-123",
              usedByAgent: false,
            },
          ],
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });

    renderContextPanel({
      sessionId: "test-session-worktree-startup-plan",
      projectName: "Builderbot",
      projectWorkingDirs: ["/Users/test/goose2/builderbot"],
    });

    const [workspaceArgs] = mockUseWorkspaceGitRuntimes.mock.calls.at(-1) as [
      WorkspaceAttachment[],
      boolean,
    ];
    expect(workspaceArgs.map((workspace) => workspace.path)).toEqual([
      "/Users/test/goose2-worktrees/chat-123/builderbot",
    ]);
  });

  it("uses each workspace's own git state for row labels and actions", async () => {
    const user = userEvent.setup();
    const mainGitState: GitState = {
      isGitRepo: true,
      currentBranch: "main",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [
        {
          path: "/Users/test/repo-a",
          branch: "main",
          isMain: true,
        },
      ],
      isWorktree: false,
      mainWorktreePath: "/Users/test/repo-a",
      localBranches: ["main"],
    };
    const linkedGitState: GitState = {
      isGitRepo: true,
      currentBranch: "feature/service",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [
        {
          path: "/Users/test/repo-b",
          branch: "main",
          isMain: true,
        },
        {
          path: "/Users/test/repo-b-worktrees/service",
          branch: "feature/service",
          isMain: false,
        },
      ],
      isWorktree: true,
      mainWorktreePath: "/Users/test/repo-b",
      localBranches: ["main", "feature/service"],
    };
    mockUseWorkspaceGitRuntimes.mockImplementation(
      (workspaces: WorkspaceAttachment[]) =>
        workspaces.map((workspace) =>
          createWorkspaceRuntime(
            workspace,
            workspace.path.includes("repo-b-worktrees")
              ? linkedGitState
              : mainGitState,
          ),
        ),
    );
    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-multiple-git-states",
          title: "Multi repo",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath("/Users/test/repo-a/app"),
              path: "/Users/test/repo-a/app",
              kind: "subdirectory",
              source: "selected",
              branch: "main",
              repositoryPath: "/Users/test/repo-a",
              worktreePath: "/Users/test/repo-a",
              usedByAgent: false,
            },
            {
              id: workspaceAttachmentIdForPath(
                "/Users/test/repo-b-worktrees/service/packages/api",
              ),
              path: "/Users/test/repo-b-worktrees/service/packages/api",
              kind: "subdirectory",
              source: "selected",
              branch: "feature/service",
              repositoryPath: "/Users/test/repo-b",
              worktreePath: "/Users/test/repo-b-worktrees/service",
              usedByAgent: false,
            },
          ],
        },
      ],
    });

    renderContextPanel({
      sessionId: "test-session-multiple-git-states",
      projectWorkingDirs: [],
    });

    expect(screen.getByText("repo-a/app")).toBeInTheDocument();
    expect(screen.getByText("repo-b/.../api")).toBeInTheDocument();
    expect(screen.getByText("main checkout")).toBeInTheDocument();
    expect(screen.getByText("service")).toBeInTheDocument();

    await openWorkspaceActionsMenu(user, /repo-b\/\.\.\.\/api/i);

    expect(
      screen.queryByRole("menuitem", { name: /^create worktree$/i }),
    ).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    await openWorkspaceActionsMenu(user, /repo-a\/app/i);

    expect(
      screen.getByRole("menuitem", { name: /^create worktree$/i }),
    ).toBeInTheDocument();
  });

  it("renders project workspaces in configured order", () => {
    renderContextPanel({
      sessionId: "test-session-workspace-order",
      projectName: "Workspace Order",
      projectWorkingDirs: ["/Users/test/z-service", "/Users/test/a-app"],
    });

    const firstWorkspace = screen.getByText("z-service");
    const secondWorkspace = screen.getByText("a-app");

    expect(
      firstWorkspace.compareDocumentPosition(secondWorkspace) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("opens and closes workspace row actions", async () => {
    const user = userEvent.setup();

    renderContextPanel({
      sessionId: "test-session-collapse",
      projectName: "Desktop UX",
      projectColor: "#22c55e",
    });

    await openWorkspaceActionsMenu(user);

    expect(
      screen.getByRole("menuitem", { name: /^create branch$/i }),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(
      screen.queryByRole("menuitem", { name: /^create branch$/i }),
    ).not.toBeInTheDocument();
  });

  it("removes the inferred project workspace from the chat", async () => {
    const user = userEvent.setup();
    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-remove-default-workspace",
          title: "Chat",
          workingDir: "/Users/test/goose2",
          workspaceAttachments: [materializedWorkspace("/Users/test/goose2")],
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });

    renderContextPanel({
      sessionId: "test-session-remove-default-workspace",
      projectName: "Desktop UX",
    });

    await openWorkspaceActionsMenu(user);
    await user.click(
      screen.getByRole("menuitem", { name: /^remove from chat$/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: /^remove workspace$/i }),
    );

    expect(
      screen.queryByText("No workspaces included yet."),
    ).not.toBeInTheDocument();
    expect(getAddWorkspaceButton()).toBeEnabled();
    expect(screen.queryByTitle("/Users/test/goose2")).not.toBeInTheDocument();
    expect(
      useChatSessionStore
        .getState()
        .getSession("test-session-remove-default-workspace")
        ?.workspaceAttachments,
    ).toEqual([
      expect.objectContaining({
        path: "/Users/test/goose2",
        source: "excluded",
      }),
    ]);
    expect(
      useChatSessionStore
        .getState()
        .getSession("test-session-remove-default-workspace")?.workingDir,
    ).toBe("/Users/test/goose2");
  });

  it("cleans up a last-use Goose-created worktree before removing it from the chat", async () => {
    const user = userEvent.setup();
    const worktreePath = "/Users/test/goose2-feature";
    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-remove-created-worktree",
          title: "Chat",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath(worktreePath),
              path: worktreePath,
              kind: "git-linked-worktree",
              source: "created",
              branch: "feat/context-panel",
              repositoryPath: "/Users/test/goose2",
              worktreePath,
              lifecycle: {
                owner: "goose",
                cleanup: "worktree",
                branch: "feat/context-panel",
                baseBranch: "main",
                repositoryPath: "/Users/test/goose2",
                worktreePath,
                createdBranch: true,
              },
              usedByAgent: false,
            },
          ],
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });

    renderContextPanel({
      sessionId: "test-session-remove-created-worktree",
      projectWorkingDirs: [],
    });

    await openWorkspaceActionsMenu(user);
    await user.click(
      screen.getByRole("menuitem", { name: /^remove from chat$/i }),
    );
    expect(
      await screen.findByRole("heading", {
        name: /^are you sure you want to remove this worktree\?$/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/goose2-feature will be deleted from disk\./i),
    ).toBeInTheDocument();
    await user.click(
      await screen.findByRole("button", { name: /^remove workspace$/i }),
    );

    expect(vi.mocked(gitApi.removeWorktree)).toHaveBeenCalledWith(
      "/Users/test/goose2",
      worktreePath,
      true,
    );
    expect(vi.mocked(gitApi.deleteBranch)).toHaveBeenCalledWith(
      "/Users/test/goose2",
      "feat/context-panel",
      true,
      "main",
    );
    expect(
      useChatSessionStore
        .getState()
        .getSession("test-session-remove-created-worktree")
        ?.workspaceAttachments,
    ).toEqual([]);
  });

  it("skips cleanup for a shared Goose-created worktree and removes only the selected workspace", async () => {
    const user = userEvent.setup();
    const worktreePath = "/Users/test/goose2-feature";
    const appPath = `${worktreePath}/app`;
    const docsPath = `${worktreePath}/docs`;
    const appAttachment = createManagedWorktreeAttachment(
      appPath,
      worktreePath,
    );
    const docsAttachment = createManagedWorktreeAttachment(
      docsPath,
      worktreePath,
    );

    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-remove-shared-worktree",
          title: "Chat",
          workspaceAttachments: [appAttachment, docsAttachment],
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });

    renderContextPanel({
      sessionId: "test-session-remove-shared-worktree",
      projectWorkingDirs: [],
    });

    await openWorkspaceActionsMenu(user, /app/i);
    await user.click(
      screen.getByRole("menuitem", { name: /^remove from chat$/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: /^remove workspace$/i }),
    );

    expect(vi.mocked(gitApi.removeWorktree)).not.toHaveBeenCalled();
    expect(vi.mocked(gitApi.deleteBranch)).not.toHaveBeenCalled();
    expect(
      useChatSessionStore
        .getState()
        .getSession("test-session-remove-shared-worktree")
        ?.workspaceAttachments,
    ).toEqual([docsAttachment]);
  });

  it("keeps a Goose-created worktree attached when cleanup fails", async () => {
    const user = userEvent.setup();
    const worktreePath = "/Users/test/goose2-feature";
    const attachment = createManagedWorktreeAttachment(
      worktreePath,
      worktreePath,
      { kind: "git-linked-worktree" },
    );
    vi.mocked(gitApi.removeWorktree).mockRejectedValueOnce(
      new Error("worktree is dirty"),
    );

    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-remove-worktree-cleanup-fails",
          title: "Chat",
          workspaceAttachments: [attachment],
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });

    renderContextPanel({
      sessionId: "test-session-remove-worktree-cleanup-fails",
      projectWorkingDirs: [],
    });

    await openWorkspaceActionsMenu(user);
    await user.click(
      screen.getByRole("menuitem", { name: /^remove from chat$/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: /^remove workspace$/i }),
    );

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        expect.stringContaining("worktree is dirty"),
      );
    });
    expect(vi.mocked(gitApi.removeWorktree)).toHaveBeenCalledWith(
      "/Users/test/goose2",
      worktreePath,
      true,
    );
    expect(vi.mocked(gitApi.deleteBranch)).not.toHaveBeenCalled();
    expect(
      useChatSessionStore
        .getState()
        .getSession("test-session-remove-worktree-cleanup-fails")
        ?.workspaceAttachments,
    ).toEqual([attachment]);
    expect(
      screen.getByRole("button", { name: /^remove workspace$/i }),
    ).toBeInTheDocument();
  });

  it("does not offer create worktree from a linked worktree row", async () => {
    const user = userEvent.setup();
    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-linked-worktree-actions",
          title: "Chat",
          workingDir: "/Users/test/goose2-feature",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath("/Users/test/goose2-feature"),
              path: "/Users/test/goose2-feature",
              kind: "git-linked-worktree",
              source: "selected",
              branch: "feat/context-panel",
              repositoryPath: "/Users/test/goose2",
              worktreePath: "/Users/test/goose2-feature",
              usedByAgent: false,
            },
          ],
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });

    renderContextPanel({
      sessionId: "test-session-linked-worktree-actions",
      projectWorkingDirs: [],
    });

    await openWorkspaceActionsMenu(user);

    expect(
      screen.getByRole("menuitem", { name: /^create branch$/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /^create worktree$/i }),
    ).not.toBeInTheDocument();
  });

  it("does not offer create worktree from a subdirectory in a linked worktree", async () => {
    const user = userEvent.setup();
    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-linked-worktree-subdir-actions",
          title: "Chat",
          workingDir: "/Users/test/goose2",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath("/Users/test/goose2"),
              path: "/Users/test/goose2",
              kind: "git-main-worktree",
              source: "inferred",
              branch: "main",
              usedByAgent: false,
            },
            {
              id: workspaceAttachmentIdForPath(
                "/Users/test/goose2-feature/src",
              ),
              path: "/Users/test/goose2-feature/src",
              kind: "subdirectory",
              source: "selected",
              branch: "feat/context-panel",
              repositoryPath: "/Users/test/goose2",
              worktreePath: "/Users/test/goose2-feature",
              usedByAgent: false,
            },
          ],
          activeWorkspaceId: workspaceAttachmentIdForPath("/Users/test/goose2"),
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });

    renderContextPanel({
      sessionId: "test-session-linked-worktree-subdir-actions",
    });

    await openWorkspaceActionsMenu(user, /goose2\/src/i);

    expect(
      screen.getByRole("menuitem", { name: /^create branch$/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /^create worktree$/i }),
    ).not.toBeInTheDocument();
  });

  it("runs linked worktree subdirectory row git actions at that worktree root", async () => {
    const user = userEvent.setup();
    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-linked-worktree-subdir-action-path",
          title: "Chat",
          workingDir: "/Users/test/goose2",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath("/Users/test/goose2"),
              path: "/Users/test/goose2",
              kind: "git-main-worktree",
              source: "inferred",
              branch: "main",
              usedByAgent: false,
            },
            {
              id: workspaceAttachmentIdForPath(
                "/Users/test/goose2-feature/src",
              ),
              path: "/Users/test/goose2-feature/src",
              kind: "subdirectory",
              source: "selected",
              branch: "feat/context-panel",
              repositoryPath: "/Users/test/goose2",
              worktreePath: "/Users/test/goose2-feature",
              usedByAgent: false,
            },
          ],
          activeWorkspaceId: workspaceAttachmentIdForPath("/Users/test/goose2"),
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
      activeWorkspaceBySession: {
        "test-session-linked-worktree-subdir-action-path": {
          path: "/Users/test/goose2",
          branch: "main",
        },
      },
    });

    renderContextPanel({
      sessionId: "test-session-linked-worktree-subdir-action-path",
    });

    await openWorkspaceActionsMenu(user, /goose2\/src/i);
    await user.click(
      screen.getByRole("menuitem", { name: /fetch remote status/i }),
    );

    expect(vi.mocked(gitApi.fetchRepo)).toHaveBeenCalledWith(
      "/Users/test/goose2-feature",
    );

    await openWorkspaceActionsMenu(user, /goose2\/src/i);
    await user.click(screen.getByRole("menuitem", { name: /^pull$/i }));

    expect(vi.mocked(gitApi.pullRepo)).toHaveBeenCalledWith(
      "/Users/test/goose2-feature",
    );

    await openWorkspaceActionsMenu(user, /goose2\/src/i);
    await user.click(
      screen.getByRole("menuitem", { name: /^create branch$/i }),
    );
    await user.type(screen.getByLabelText("Branch name"), "feature/from-row");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /^create branch$/i,
      }),
    );

    expect(vi.mocked(gitApi.createBranch)).toHaveBeenCalledWith(
      "/Users/test/goose2-feature",
      "feature/from-row",
      "feat/context-panel",
    );
  });

  it("adds a workspace directory without selecting an active workspace", async () => {
    const user = userEvent.setup();
    mockOpenDialog.mockResolvedValue("/Users/test/goose2-feature");
    vi.mocked(gitApi.getGitState).mockResolvedValue({
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
      localBranches: ["main", "feat/context-panel"],
    });

    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-add-existing",
          title: "Chat",
          workingDir: "/Users/test/goose2",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath("/Users/test/goose2"),
              path: "/Users/test/goose2",
              kind: "git-main-worktree",
              source: "inferred",
              branch: "main",
              usedByAgent: false,
            },
          ],
          activeWorkspaceId: workspaceAttachmentIdForPath("/Users/test/goose2"),
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });

    renderContextPanel({
      sessionId: "test-session-add-existing",
      projectName: "Desktop UX",
    });

    const dialog = await openAddWorkspaceDialog(user);
    await chooseWorkspaceDirectory(user, dialog);

    await waitFor(() => {
      expect(mockOpenDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Add workspace",
          directory: true,
          multiple: false,
        }),
      );
    });
    expect(vi.mocked(gitApi.getGitState)).toHaveBeenCalledWith(
      "/Users/test/goose2-feature",
    );
    await clickAddWorkspace(user, dialog);

    const session = useChatSessionStore
      .getState()
      .getSession("test-session-add-existing");
    expect(session?.workspaceAttachments).toEqual([
      expect.objectContaining({
        path: "/Users/test/goose2",
        branch: "main",
      }),
      expect.objectContaining({
        path: "/Users/test/goose2-feature",
        branch: "feat/context-panel",
        kind: "git-linked-worktree",
        source: "selected",
      }),
    ]);
    expect(useChatSessionStore.getState().activeWorkspaceBySession).toEqual({});
    expect(screen.getByTitle("/Users/test/goose2-feature")).toBeInTheDocument();
  });

  it("adds an attached worktree root from the workspace start selector", async () => {
    const user = userEvent.setup();

    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-add-existing-worktree",
          title: "Chat",
          workingDir: "/Users/test/goose2",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath("/Users/test/goose2"),
              path: "/Users/test/goose2",
              kind: "git-main-worktree",
              source: "inferred",
              branch: "main",
              usedByAgent: false,
            },
            {
              id: workspaceAttachmentIdForPath(
                "/Users/test/goose2-feature/src",
              ),
              path: "/Users/test/goose2-feature/src",
              kind: "subdirectory",
              source: "selected",
              branch: "feat/context-panel",
              repositoryPath: "/Users/test/goose2",
              worktreePath: "/Users/test/goose2-feature",
              usedByAgent: false,
            },
          ],
          activeWorkspaceId: workspaceAttachmentIdForPath("/Users/test/goose2"),
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });

    renderContextPanel({
      sessionId: "test-session-add-existing-worktree",
      projectName: "Desktop UX",
    });

    const dialog = await openAddWorkspaceDialog(user);
    await selectWorkspaceStart(user, /goose2-feature/i);
    await clickAddWorkspace(user, dialog);

    const session = useChatSessionStore
      .getState()
      .getSession("test-session-add-existing-worktree");
    expect(session?.workspaceAttachments).toEqual([
      expect.objectContaining({
        path: "/Users/test/goose2",
        branch: "main",
      }),
      expect.objectContaining({
        path: "/Users/test/goose2-feature/src",
        branch: "feat/context-panel",
        kind: "subdirectory",
        source: "selected",
      }),
      expect.objectContaining({
        path: "/Users/test/goose2-feature",
        branch: "feat/context-panel",
        kind: "git-linked-worktree",
        source: "selected",
      }),
    ]);
    expect(useChatSessionStore.getState().activeWorkspaceBySession).toEqual({});
    expect(screen.getByTitle("/Users/test/goose2-feature")).toBeInTheDocument();
  });

  it("shows repo worktrees after selecting a repo start point", async () => {
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
          {
            path: "/Users/test/goose2-feature",
            branch: "feat/context-panel",
            isMain: false,
          },
          {
            path: "/Users/test/goose2-other",
            branch: "feat/other",
            isMain: false,
          },
        ],
        isWorktree: false,
        mainWorktreePath: "/Users/test/goose2",
        localBranches: ["main", "feat/context-panel", "feat/other"],
      },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mockRefetch,
    });

    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-repo-worktree-selector",
          title: "Chat",
          workingDir: "/Users/test/goose2",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath("/Users/test/goose2"),
              path: "/Users/test/goose2",
              kind: "git-main-worktree",
              source: "inferred",
              branch: "main",
              usedByAgent: false,
            },
            {
              id: workspaceAttachmentIdForPath(
                "/Users/test/goose2-feature/src",
              ),
              path: "/Users/test/goose2-feature/src",
              kind: "subdirectory",
              source: "selected",
              branch: "feat/context-panel",
              repositoryPath: "/Users/test/goose2",
              worktreePath: "/Users/test/goose2-feature",
              usedByAgent: false,
            },
          ],
          activeWorkspaceId: workspaceAttachmentIdForPath("/Users/test/goose2"),
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });

    renderContextPanel({
      sessionId: "test-session-repo-worktree-selector",
      projectName: "Desktop UX",
    });

    const dialog = await openAddWorkspaceDialog(user);
    const worktreeSelect = within(dialog).getByRole("combobox", {
      name: /^worktree$/i,
    });
    expect(worktreeSelect).toHaveTextContent("main checkout");

    await user.click(worktreeSelect);
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("main checkout");
    expect(options[1]).toHaveTextContent("goose2-feature");
    expect(options[1]).not.toHaveTextContent("Attached");
    expect(options[2]).toHaveTextContent("goose2-other");
    await user.click(options[2]);
    await clickAddWorkspace(user, dialog);

    expect(
      useChatSessionStore
        .getState()
        .getSession("test-session-repo-worktree-selector")
        ?.workspaceAttachments,
    ).toEqual([
      expect.objectContaining({
        path: "/Users/test/goose2",
        branch: "main",
      }),
      expect.objectContaining({
        path: "/Users/test/goose2-feature/src",
        branch: "feat/context-panel",
        kind: "subdirectory",
        source: "selected",
      }),
      expect.objectContaining({
        path: "/Users/test/goose2-other",
        branch: "feat/other",
        kind: "git-linked-worktree",
        source: "selected",
      }),
    ]);
  });

  it("starts directory picking from the selected worktree", async () => {
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
          {
            path: "/Users/test/goose2-feature",
            branch: "feat/context-panel",
            isMain: false,
          },
        ],
        isWorktree: false,
        mainWorktreePath: "/Users/test/goose2",
        localBranches: ["main", "feat/context-panel"],
      },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mockRefetch,
    });

    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-worktree-directory-picker",
          title: "Chat",
          workingDir: "/Users/test/goose2",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath("/Users/test/goose2"),
              path: "/Users/test/goose2",
              kind: "git-main-worktree",
              source: "inferred",
              branch: "main",
              usedByAgent: false,
            },
          ],
          activeWorkspaceId: workspaceAttachmentIdForPath("/Users/test/goose2"),
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });

    renderContextPanel({
      sessionId: "test-session-worktree-directory-picker",
      projectName: "Desktop UX",
    });

    const dialog = await openAddWorkspaceDialog(user);
    const worktreeSelect = within(dialog).getByRole("combobox", {
      name: /^worktree$/i,
    });

    await user.click(worktreeSelect);
    await user.click(
      await screen.findByRole("option", { name: /goose2-feature/i }),
    );
    await chooseWorkspaceDirectory(user, dialog);

    expect(mockOpenDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        defaultPath: "/Users/test/goose2-feature",
        directory: true,
        multiple: false,
      }),
    );
  });

  it("keeps a picked repo start point when selecting one of its worktrees", async () => {
    const user = userEvent.setup();
    mockOpenDialog.mockResolvedValue("/Users/test/cash-server");
    vi.mocked(gitApi.getGitState).mockResolvedValueOnce({
      isGitRepo: true,
      currentBranch: "main",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [
        {
          path: "/Users/test/cash-server",
          branch: "main",
          isMain: true,
        },
        {
          path: "/Users/test/cash-server-worktrees/feature",
          branch: "feat/builderbot",
          isMain: false,
        },
      ],
      isWorktree: false,
      mainWorktreePath: "/Users/test/cash-server",
      localBranches: ["main", "feat/builderbot"],
    });

    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-picked-repo-worktree-selector",
          title: "Chat",
          workingDir: "/Users/test/goose2",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath("/Users/test/goose2"),
              path: "/Users/test/goose2",
              kind: "git-main-worktree",
              source: "inferred",
              branch: "main",
              usedByAgent: false,
            },
          ],
          activeWorkspaceId: workspaceAttachmentIdForPath("/Users/test/goose2"),
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });

    renderContextPanel({
      sessionId: "test-session-picked-repo-worktree-selector",
      projectName: "Desktop UX",
    });

    const dialog = await openAddWorkspaceDialog(user);
    await chooseWorkspaceDirectory(user, dialog);

    await waitFor(() => {
      expect(
        within(dialog).getByRole("combobox", { name: /local repo/i }),
      ).toHaveTextContent("cash-server");
    });

    const worktreeSelect = within(dialog).getByRole("combobox", {
      name: /^worktree$/i,
    });
    await user.click(worktreeSelect);
    await user.click(
      await screen.findByRole("option", { name: /cash-server-worktrees/i }),
    );

    expect(worktreeSelect).toHaveTextContent("feature");
    await clickAddWorkspace(user, dialog);

    expect(
      useChatSessionStore
        .getState()
        .getSession("test-session-picked-repo-worktree-selector")
        ?.workspaceAttachments,
    ).toEqual([
      expect.objectContaining({
        path: "/Users/test/goose2",
        branch: "main",
      }),
      expect.objectContaining({
        path: "/Users/test/cash-server-worktrees/feature",
        branch: "feat/builderbot",
        kind: "git-linked-worktree",
        source: "selected",
      }),
    ]);
  });

  it("does not offer worktree creation when starting from a worktree", async () => {
    const user = userEvent.setup();
    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-worktree-start-no-create",
          title: "Chat",
          workingDir: "/Users/test/goose2-feature",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath("/Users/test/goose2-feature"),
              path: "/Users/test/goose2-feature",
              kind: "git-linked-worktree",
              source: "selected",
              branch: "feat/context-panel",
              repositoryPath: "/Users/test/goose2",
              worktreePath: "/Users/test/goose2-feature",
              usedByAgent: false,
            },
          ],
          activeWorkspaceId: workspaceAttachmentIdForPath(
            "/Users/test/goose2-feature",
          ),
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });

    renderContextPanel({
      sessionId: "test-session-worktree-start-no-create",
      projectWorkingDirs: [],
    });

    const dialog = await openAddWorkspaceDialog(user);

    expect(
      within(dialog).getByRole("combobox", { name: /local repo/i }),
    ).toHaveTextContent("goose2-feature");
    expect(
      within(dialog).queryByRole("checkbox", { name: /create worktree/i }),
    ).not.toBeInTheDocument();
  });

  it("shows path and init button for non-git directory", async () => {
    const user = userEvent.setup();
    const onOpenTerminalAtPath = vi.fn();
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
      onOpenTerminalAtPath,
    });

    await openWorkspaceActionsMenu(user, /not-a-repo/i);
    expect(
      screen.getByRole("menuitem", { name: /open terminal/i }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: /open terminal/i }));

    expect(onOpenTerminalAtPath).toHaveBeenCalledWith("/Users/test/not-a-repo");
    await openWorkspaceActionsMenu(user, /not-a-repo/i);
    expect(
      screen.getByRole("menuitem", { name: /initialize git/i }),
    ).toBeInTheDocument();
  });

  it("shows artifact folder controls for no-project non-git chats", async () => {
    const user = userEvent.setup();
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
    });

    expect(screen.getByText("General chat")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /change folder/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /change folder/i }),
    ).toHaveTextContent("Artifact folder");
    expect(
      screen.getByRole("button", { name: /change folder/i }),
    ).toHaveTextContent("goose artifacts");
    expect(screen.queryByText("Included workspaces")).not.toBeInTheDocument();

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
    expect(localStorage.getItem("goose:artifact-root-path")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /initialize git/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps add workspace available when a chat has no working folder", async () => {
    const user = userEvent.setup();
    mockOpenDialog.mockResolvedValue("/Users/test/builderbot");
    mockUseGitState.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mockRefetch,
    });

    renderContextPanel({
      sessionId: "test-session-no-working-folder",
      projectWorkingDirs: [],
      sessionWorkingDir: null,
    });

    expect(screen.queryByText("Folder not set")).not.toBeInTheDocument();
    expect(getAddWorkspaceButton()).toBeEnabled();

    await user.click(getAddWorkspaceButton());
    const dialog = await screen.findByRole("dialog", {
      name: /add workspace/i,
    });
    await chooseWorkspaceDirectory(user, dialog);

    await waitFor(() => {
      expect(mockOpenDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Add workspace",
          directory: true,
          multiple: false,
        }),
      );
    });
    expect(vi.mocked(gitApi.getGitState)).toHaveBeenCalledWith(
      "/Users/test/builderbot",
    );
  });

  it("can include a worktree when a project has no configured folder", async () => {
    const user = userEvent.setup();
    mockOpenDialog.mockResolvedValue("/Users/test/builderbot-feature");
    mockUseGitState.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mockRefetch,
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-project-artifact-folder",
          title: "Chat",
          workingDir: "/Users/test/goose artifacts",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });

    renderContextPanel({
      sessionId: "test-session-project-artifact-folder",
      projectName: "Desktop UX",
      projectWorkingDirs: [],
      sessionWorkingDir: "/Users/test/goose artifacts",
    });

    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(
      screen.queryByText("No workspaces included yet."),
    ).not.toBeInTheDocument();
    expect(getAddWorkspaceButton()).toBeEnabled();
    expect(screen.queryByText("Changes")).not.toBeInTheDocument();
    expect(screen.queryByText("goose artifacts")).not.toBeInTheDocument();
    expect(screen.queryByText("Folder not set")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /change folder/i }),
    ).not.toBeInTheDocument();
    const dialog = await openAddWorkspaceDialog(user);
    await chooseWorkspaceDirectory(user, dialog);

    await waitFor(() => {
      expect(mockOpenDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Add workspace",
          directory: true,
          multiple: false,
        }),
      );
    });
    expect(vi.mocked(gitApi.getGitState)).toHaveBeenCalledWith(
      "/Users/test/builderbot-feature",
    );
    await clickAddWorkspace(user, dialog);
    await waitFor(() => {
      expect(
        useChatSessionStore
          .getState()
          .getSession("test-session-project-artifact-folder")
          ?.workspaceAttachments,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "/Users/test/builderbot-feature",
            kind: "git-linked-worktree",
            branch: "feat/chat-worktrees",
            source: "selected",
          }),
        ]),
      );
    });
    expect(mockUpdateWorkingDir).not.toHaveBeenCalled();
    expect(useChatSessionStore.getState().activeWorkspaceBySession).toEqual({});
    expect(
      await screen.findByTitle("/Users/test/builderbot-feature"),
    ).toBeInTheDocument();
    expect(screen.queryByText("goose artifacts")).not.toBeInTheDocument();
  });

  it("starts worktree creation from an empty project by choosing a source repository", async () => {
    const user = userEvent.setup();
    mockOpenDialog.mockResolvedValue("/Users/test/builderbot");
    mockUseGitState.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mockRefetch,
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-create-worktree-empty",
          title: "Chat",
          workingDir: "/Users/test/goose artifacts",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });

    renderContextPanel({
      sessionId: "test-session-create-worktree-empty",
      projectName: "Builderbot",
      projectWorkingDirs: [],
      sessionWorkingDir: "/Users/test/goose artifacts",
    });

    const dialog = await openAddWorkspaceDialog(user);
    await chooseWorkspaceDirectory(user, dialog);

    await waitFor(() => {
      expect(mockOpenDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Add workspace",
          directory: true,
          multiple: false,
        }),
      );
    });
    expect(vi.mocked(gitApi.getGitState)).toHaveBeenCalledWith(
      "/Users/test/builderbot",
    );
    await enableCreateWorktree(user, dialog);
    await clickAddWorkspace(user, dialog);
    expect(
      within(await screen.findByRole("dialog")).getByRole("heading", {
        name: /new worktree/i,
      }),
    ).toBeInTheDocument();
    expect(
      useChatSessionStore
        .getState()
        .getSession("test-session-create-worktree-empty")?.workspaceAttachments,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/Users/test/builderbot" }),
      ]),
    );
    expect(useChatSessionStore.getState().activeWorkspaceBySession).toEqual({});
  });

  it("does not show folder controls for git-backed included workspaces", () => {
    renderContextPanel({
      sessionId: "test-session-git-change-folder",
      projectName: "Desktop UX",
    });

    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("goose2")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /change folder/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Desktop UX")).toBeInTheDocument();
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

  it("shows workspace row actions in the menu", async () => {
    const user = userEvent.setup();

    renderContextPanel({ sessionId: "test-session-6" });

    expect(
      screen.queryByRole("button", { name: /^add a workspace$/i }),
    ).not.toBeInTheDocument();
    expect(getWorkspaceSectionActionsMenuButton()).toBeInTheDocument();
    expect(getWorkspaceActionsMenuButton()).toBeInTheDocument();

    await openWorkspaceActionsMenu(user);

    expect(
      screen.getByRole("menuitem", { name: /^create branch$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /^create branch$/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /^add workspace$/i }),
    ).toBeNull();
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

    await openWorkspaceActionsMenu(user);

    expect(
      screen.getByRole("menuitem", { name: /^pull 3 commits$/i }),
    ).toBeInTheDocument();
  });

  it("creates a branch from the workspace actions dialog and updates included metadata", async () => {
    const user = userEvent.setup();
    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-7",
          title: "Chat",
          workingDir: "/Users/test/goose2",
          workspaceAttachments: [materializedWorkspace("/Users/test/goose2")],
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });

    renderContextPanel({ sessionId: "test-session-7" });

    await openWorkspaceActionsMenu(user);
    await user.click(
      screen.getByRole("menuitem", { name: /^create branch$/i }),
    );
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
      useChatSessionStore.getState().getSession("test-session-7"),
    ).toMatchObject({
      workspaceAttachments: [
        expect.objectContaining({
          path: "/Users/test/goose2",
          branch: "feature/new-branch",
        }),
      ],
    });
  });

  it("creates a worktree from the add workspace dialog and includes it", async () => {
    const user = userEvent.setup();

    useChatSessionStore.setState({
      sessions: [
        {
          id: "test-session-8",
          title: "Chat",
          workingDir: "/Users/test/goose2",
          workspaceAttachments: [materializedWorkspace("/Users/test/goose2")],
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });
    vi.mocked(gitApi.createWorktree).mockResolvedValue({
      path: "/Users/test/goose2-worktrees/new-worktree",
      branch: "feature/new-worktree",
    });

    renderContextPanel({ sessionId: "test-session-8" });

    const addWorkspaceDialog = await openAddWorkspaceDialog(user);
    await enableCreateWorktree(user, addWorkspaceDialog);
    await clickAddWorkspace(user, addWorkspaceDialog);
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
    const session = useChatSessionStore.getState().getSession("test-session-8");
    expect(session?.workspaceAttachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/Users/test/goose2",
          source: "inferred",
        }),
        expect.objectContaining({
          path: "/Users/test/goose2-worktrees/new-worktree",
          branch: "feature/new-worktree",
          kind: "git-linked-worktree",
          source: "created",
        }),
      ]),
    );
    expect(
      screen.getByTitle("/Users/test/goose2-worktrees/new-worktree"),
    ).toBeInTheDocument();
  });

  it("reopens create actions from the workspace menu after canceling", async () => {
    const user = userEvent.setup();

    renderContextPanel({ sessionId: "test-session-8b" });

    await openWorkspaceActionsMenu(user);
    await user.click(
      screen.getByRole("menuitem", { name: /^create branch$/i }),
    );

    expect(
      within(screen.getByRole("dialog")).getByRole("heading", {
        name: /new branch/i,
      }),
    ).toBeInTheDocument();

    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /^cancel$/i,
      }),
    );

    await openWorkspaceActionsMenu(user);
    await user.click(
      screen.getByRole("menuitem", { name: /^create branch$/i }),
    );

    expect(
      within(screen.getByRole("dialog")).getByRole("heading", {
        name: /new branch/i,
      }),
    ).toBeInTheDocument();
  });

  it("syncs worktree name into branch name until branch name is edited manually", async () => {
    const user = userEvent.setup();

    renderContextPanel({ sessionId: "test-session-9" });

    const addWorkspaceDialog = await openAddWorkspaceDialog(user);
    await enableCreateWorktree(user, addWorkspaceDialog);
    await clickAddWorkspace(user, addWorkspaceDialog);

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
