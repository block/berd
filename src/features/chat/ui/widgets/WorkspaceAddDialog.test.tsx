import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import type { GitState } from "@/shared/types/git";
import { WorkspaceAddDialog } from "./WorkspaceAddDialog";

const { mockEnsureDirectory, mockGetGitState, mockOpenDialog, mockToastError } =
  vi.hoisted(() => ({
    mockEnsureDirectory: vi.fn(),
    mockGetGitState: vi.fn(),
    mockOpenDialog: vi.fn(),
    mockToastError: vi.fn(),
  }));

vi.mock("sonner", () => ({
  toast: {
    error: mockToastError,
  },
}));

vi.mock("@/shared/api/system", () => ({
  ensureDirectory: mockEnsureDirectory,
}));

vi.mock("@/shared/api/git", () => ({
  getGitState: mockGetGitState,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mockOpenDialog,
}));

const repoWorkspace: WorkspaceAttachment = {
  id: "path:/Users/test/cash-server",
  path: "/Users/test/cash-server",
  kind: "git-main-worktree",
  source: "selected",
  branch: "main",
  repositoryPath: "/Users/test/cash-server",
  worktreePath: "/Users/test/cash-server",
  usedByAgent: false,
};

const repoGitState: GitState = {
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
  ],
  isWorktree: false,
  mainWorktreePath: "/Users/test/cash-server",
  localBranches: ["main"],
};

function renderDialog(
  props: Partial<Parameters<typeof WorkspaceAddDialog>[0]>,
) {
  return render(
    <WorkspaceAddDialog
      open={true}
      currentProjectPath="/Users/test/cash-server"
      includedWorkspaces={[repoWorkspace]}
      gitStateByWorkspaceId={{ [repoWorkspace.id]: repoGitState }}
      onClose={vi.fn()}
      onInclude={vi.fn()}
      {...props}
    />,
  );
}

describe("WorkspaceAddDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureDirectory.mockResolvedValue(undefined);
    mockGetGitState.mockResolvedValue(repoGitState);
    mockOpenDialog.mockResolvedValue(null);

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
  });

  it("uses folder wording when adding a project folder", () => {
    renderDialog({ context: "project" });

    expect(
      screen.getByRole("dialog", { name: /^add folder$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Folder will be associated with the project chats."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^choose folder$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^folder$/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Folder$/)).not.toBeInTheDocument();
    expect(screen.getByText("Choose a folder")).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: /^local repo$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: /^folder$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: /^worktree$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /add another workspace/i }),
    ).not.toBeInTheDocument();
  });

  it("opens the folder picker when selecting the directory start point", async () => {
    const user = userEvent.setup();
    renderDialog({ context: "project" });

    await user.click(screen.getByRole("button", { name: /^folder$/i }));

    await waitFor(() => {
      expect(mockOpenDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPath: "/Users/test/cash-server",
          directory: true,
          multiple: false,
          title: "Select folder",
        }),
      );
    });
  });

  it("shows detected worktree context when a linked worktree folder is picked", async () => {
    const user = userEvent.setup();
    const linkedWorktreeGitState: GitState = {
      ...repoGitState,
      currentBranch: "feature",
      isWorktree: true,
      mainWorktreePath: "/Users/test/cash-server",
      worktrees: [
        {
          path: "/Users/test/cash-server",
          branch: "main",
          isMain: true,
        },
        {
          path: "/Users/test/cash-server-worktrees/feature",
          branch: "feature",
          isMain: false,
        },
      ],
    };
    mockOpenDialog.mockResolvedValue(
      "/Users/test/cash-server-worktrees/feature",
    );
    mockGetGitState.mockResolvedValue(linkedWorktreeGitState);
    renderDialog({
      context: "project",
      includedWorkspaces: [],
      gitStateByWorkspaceId: {},
    });

    await user.click(screen.getByRole("button", { name: /^folder$/i }));

    await waitFor(() => {
      expect(screen.getByText("feature")).toBeInTheDocument();
    });
    expect(screen.queryByText("Git worktree")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        (_, element) =>
          element?.textContent === "/Users/test/cash-server-worktrees/feature",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /^folder$/i })).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: /^worktree$/i }),
    ).not.toBeInTheDocument();
  });
});
