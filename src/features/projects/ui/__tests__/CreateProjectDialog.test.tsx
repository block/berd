import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { ProjectInfo } from "../../api/projects";
import {
  createProject,
  scanProjectIcons,
  updateProject,
} from "../../api/projects";
import { checkDirectoriesExist, resolvePath } from "@/shared/api/pathResolver";
import { CreateProjectDialog } from "../CreateProjectDialog";
import { setMultiWorkspaceEnabled } from "@/features/workspaces/multiWorkspacePreference";

// ── ResizeObserver polyfill (needed by Radix Select in jsdom) ────────

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??=
  ResizeObserverStub as unknown as typeof ResizeObserver;

if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

// ── Mocks ────────────────────────────────────────────────────────────

const gitMocks = vi.hoisted(() => ({
  getGitState: vi.fn(),
}));
const pendingProjectProbe = new Promise<never>(() => {});

vi.mock("@/shared/api/system", () => ({
  getHomeDir: vi.fn().mockResolvedValue("/home/user"),
  ensureDirectory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/shared/api/git", () => ({
  getGitState: gitMocks.getGitState,
}));

vi.mock("../../api/projects", () => ({
  createProject: vi.fn().mockResolvedValue({
    id: "new-1",
    path: "/tmp/projects/new-1.md",
    name: "Test",
    description: "",
    prompt: "",
    icon: "tabler:folder-code",
    color: "olive",
    projectWorkspaces: [],
    workingDirs: [],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
  }),
  updateProject: vi.fn().mockResolvedValue({
    id: "proj-1",
    path: "/tmp/projects/proj-1.md",
    name: "Updated",
    description: "",
    prompt: "",
    icon: "tabler:folder-code",
    color: "pink",
    projectWorkspaces: [],
    workingDirs: [],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
  }),
  scanProjectIcons: vi.fn().mockResolvedValue([]),
  readProjectIcon: vi.fn().mockResolvedValue({
    icon: "data:image/png;base64,aWNvbg==",
  }),
  projectWorkspaceFromDirectory: vi.fn(
    (
      directory: string,
      startupMode:
        | "none"
        | "auto-worktree"
        | "ask-worktree"
        | "worktree" = "none",
    ) =>
      directory
        ? {
            id: `path:${directory}`,
            path: directory,
            kind: "directory",
            source: "inferred",
            branch: null,
            usedByAgent: false,
            startupMode,
          }
        : null,
  ),
  isWorktreeStartupMode: vi.fn(
    (mode: string) =>
      mode === "worktree" ||
      mode === "auto-worktree" ||
      mode === "ask-worktree",
  ),
  normalizeProjectWorkspaces: vi.fn(
    (
      workspaces:
        | Array<{
            path: string;
            startupMode?:
              | "none"
              | "auto-worktree"
              | "ask-worktree"
              | "worktree";
          }>
        | undefined,
      workingDirs: string[] = [],
      useWorktrees = false,
    ) => {
      if (workspaces?.length) {
        return workspaces;
      }
      return workingDirs.filter(Boolean).map((directory) => ({
        id: `path:${directory}`,
        path: directory,
        kind: "directory",
        source: "inferred",
        branch: null,
        usedByAgent: false,
        startupMode: useWorktrees ? "auto-worktree" : "none",
      }));
    },
  ),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/features/chat/ui/widgets/WorkspaceAddDialog", () => ({
  WorkspaceAddTrigger: ({
    label,
    onClick,
    disabled,
    loading,
  }: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    loading?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled || loading}>
      {label}
    </button>
  ),
}));

vi.mock("@/shared/api/pathResolver", () => ({
  resolvePath: vi
    .fn()
    .mockImplementation(async ({ parts }: { parts: string[] }) => ({
      path: parts[0],
    })),
  checkDirectoriesExist: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../artifact/ProjectArtifactPreview", () => ({
  ProjectArtifactPreview: ({
    input,
  }: {
    input: { artifact?: { seed: number } | null; name: string };
  }) => (
    <div
      data-testid="project-artifact-preview"
      data-artifact-seed={input.artifact?.seed ?? ""}
    >
      {input.name}
    </div>
  ),
}));

// ── Helpers ───────────────────────────────────────────────────────────

function makeEditingProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "proj-1",
    path: "/tmp/projects/proj-1.md",
    name: "My Project",
    description: "A test project",
    prompt: "Do the thing",
    icon: "tabler:folder-code",
    color: "pink",
    projectWorkspaces: [],
    workingDirs: ["/home/user/code"],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
    artifact: null,
    ...overrides,
  };
}

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  onCreated: vi.fn(),
};

function gitStateForPath(path: string) {
  return {
    isGitRepo: true,
    currentBranch: "main",
    dirtyFileCount: 0,
    incomingCommitCount: 0,
    worktrees: [{ path, branch: "main", isMain: true }],
    isWorktree: false,
    mainWorktreePath: path,
    localBranches: ["main"],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("CreateProjectDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    setMultiWorkspaceEnabled(true);
    vi.mocked(openDialog).mockResolvedValue(null);
    gitMocks.getGitState.mockImplementation(() => pendingProjectProbe);
    vi.mocked(resolvePath).mockImplementation(async ({ parts }) => ({
      path: parts[0],
    }));
    vi.mocked(checkDirectoriesExist).mockResolvedValue([]);
  });

  describe("form populates on open", () => {
    it("populates the name field when opening with an editingProject", async () => {
      const editingProject = makeEditingProject();

      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={editingProject}
        />,
      );

      const nameInput = screen.getByPlaceholderText("Project Alpha");
      expect(nameInput).toHaveValue("My Project");
      await waitFor(() => expect(gitMocks.getGitState).toHaveBeenCalled());
    });

    it("shows Edit project title when editingProject is provided", async () => {
      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={makeEditingProject()}
        />,
      );

      expect(screen.getByText("Edit project")).toBeInTheDocument();
      await waitFor(() => expect(gitMocks.getGitState).toHaveBeenCalled());
    });

    it("shows Create a project title without editingProject", () => {
      render(<CreateProjectDialog {...defaultProps} isOpen={true} />);

      expect(screen.getByText("Create a project")).toBeInTheDocument();
    });

    it("populates the prompt textarea when editing", async () => {
      const editingProject = makeEditingProject({
        prompt: "Goal of this project",
      });

      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={editingProject}
        />,
      );

      const textarea = screen.getByPlaceholderText(
        "Goals, context, instructions, links to docs…",
      );
      expect(textarea).toHaveValue("Goal of this project");
      await waitFor(() => expect(gitMocks.getGitState).toHaveBeenCalled());
    });
  });

  describe("form does NOT reset on re-render while open", () => {
    it("preserves typed name when editingProject reference changes but dialog stays open", async () => {
      const user = userEvent.setup();
      const editingProject1 = makeEditingProject();

      const { rerender } = render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={editingProject1}
        />,
      );

      const nameInput = screen.getByPlaceholderText("Project Alpha");
      expect(nameInput).toHaveValue("My Project");

      await user.clear(nameInput);
      await user.type(nameInput, "Modified Name");
      expect(nameInput).toHaveValue("Modified Name");

      const editingProject2 = makeEditingProject();
      expect(editingProject1).not.toBe(editingProject2);

      rerender(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={editingProject2}
        />,
      );

      expect(nameInput).toHaveValue("Modified Name");
    });
  });

  describe("form populates again on close and reopen", () => {
    it("re-populates fields when dialog closes and reopens with a different project", async () => {
      const project1 = makeEditingProject({
        name: "Project Alpha",
        prompt: "Alpha goal",
      });

      const { rerender } = render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={project1}
        />,
      );

      expect(screen.getByPlaceholderText("Project Alpha")).toHaveValue(
        "Project Alpha",
      );

      rerender(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={false}
          editingProject={project1}
        />,
      );

      const project2 = makeEditingProject({
        name: "Project Beta",
        prompt: "Beta goal",
      });

      rerender(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={project2}
        />,
      );

      const nameInput = screen.getByPlaceholderText("Project Alpha");
      expect(nameInput).toHaveValue("Project Beta");

      const textarea = screen.getByPlaceholderText(
        "Goals, context, instructions, links to docs…",
      );
      expect(textarea).toHaveValue("Beta goal");
      await waitFor(() => expect(gitMocks.getGitState).toHaveBeenCalled());
    });
  });

  describe("create mode", () => {
    it("uses initialWorkingDir to derive project name", async () => {
      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          initialWorkingDir="/home/user/my-repo"
        />,
      );

      const nameInput = screen.getByPlaceholderText("Project Alpha");
      expect(nameInput).toHaveValue("my-repo");
      await waitFor(() => expect(gitMocks.getGitState).toHaveBeenCalled());
    });

    it("shows workspace policy for a resolved Git initial folder", async () => {
      vi.mocked(resolvePath).mockImplementation(async ({ parts }) => ({
        path: parts[0].replace("~", "/home/user"),
      }));
      gitMocks.getGitState.mockResolvedValue(
        gitStateForPath("/home/user/code"),
      );

      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          initialWorkingDir="~/code"
        />,
      );

      expect(
        await screen.findByRole("combobox", {
          name: /new chat behavior for code/i,
        }),
      ).toHaveTextContent("Configure new chats");
      expect(gitMocks.getGitState).toHaveBeenCalledWith("/home/user/code");
    });

    it("labels the submit button as create project", () => {
      render(<CreateProjectDialog {...defaultProps} isOpen={true} />);

      expect(
        screen.getByRole("button", { name: "Create project" }),
      ).toBeInTheDocument();
    });

    it("renders a live artifact preview without pinning on save", async () => {
      const user = userEvent.setup();
      render(<CreateProjectDialog {...defaultProps} isOpen={true} />);

      await user.type(screen.getByPlaceholderText("Project Alpha"), "Launch");

      expect(screen.getByTestId("project-artifact-preview")).toHaveTextContent(
        "Launch",
      );

      await user.click(screen.getByRole("button", { name: "Create project" }));

      await waitFor(() => expect(createProject).toHaveBeenCalledOnce());
      expect(defaultProps.onCreated).toHaveBeenCalledOnce();
    });

    it("saves the describe field as the project prompt", async () => {
      const user = userEvent.setup();
      render(<CreateProjectDialog {...defaultProps} isOpen={true} />);

      await user.type(screen.getByPlaceholderText("Project Alpha"), "Launch");
      await user.type(
        screen.getByPlaceholderText(
          "Goals, context, instructions, links to docs…",
        ),
        "Help me ship the launch work.",
      );
      await user.click(screen.getByRole("button", { name: "Create project" }));

      expect(createProject).toHaveBeenCalledWith(
        "Launch",
        "",
        "Help me ship the launch work.",
        expect.any(String),
        expect.any(String),
        [],
        false,
        [],
      );
    });

    it("scans the selected working directory for project icons", async () => {
      vi.useFakeTimers();
      try {
        render(
          <CreateProjectDialog
            {...defaultProps}
            isOpen={true}
            initialWorkingDir="/home/user/my-repo"
          />,
        );

        expect(screen.queryByText("Scanning...")).not.toBeInTheDocument();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(250);
        });

        expect(scanProjectIcons).toHaveBeenCalledWith(["/home/user/my-repo"]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("edit mode", () => {
    it("uses saved artifact metadata until the draft project name changes", async () => {
      const user = userEvent.setup();
      const editingProject = makeEditingProject({
        artifact: {
          seed: 1234,
          color: "pink",
          mood: "serene",
          moodIntensity: 0.5,
          contentMode: "cubeStatic",
        },
      });

      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={editingProject}
        />,
      );

      const preview = screen.getByTestId("project-artifact-preview");
      expect(preview).toHaveAttribute("data-artifact-seed", "1234");

      const nameInput = screen.getByPlaceholderText("Project Alpha");
      await user.clear(nameInput);
      await user.type(nameInput, "Renamed Project");

      expect(preview).toHaveAttribute("data-artifact-seed", "");
    });

    it("adds a folder directly from the native folder picker", async () => {
      const user = userEvent.setup();
      vi.mocked(openDialog).mockResolvedValue("/home/user/newcode");
      gitMocks.getGitState.mockImplementation(async (path: string) =>
        gitStateForPath(path),
      );
      const editingProject = makeEditingProject({
        workingDirs: ["/home/user/code"],
      });

      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={editingProject}
        />,
      );

      await user.click(
        screen.getByRole("button", {
          name: "Add another folder",
        }),
      );
      await waitFor(() =>
        expect(openDialog).toHaveBeenCalledWith(
          expect.objectContaining({
            defaultPath: "/home/user/code",
            directory: true,
            multiple: false,
          }),
        ),
      );
      expect(
        await screen.findByRole("button", { name: "Edit newcode" }),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(updateProject).toHaveBeenCalledOnce());
      const savedWorkingDirs =
        vi.mocked(updateProject).mock.calls[0][1].workingDirs ?? [];
      expect(savedWorkingDirs).toEqual([
        "/home/user/code",
        "/home/user/newcode",
      ]);
      expect(
        vi.mocked(updateProject).mock.calls[0][1].projectWorkspaces,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "/home/user/newcode",
            startupMode: "none",
          }),
        ]),
      );
    });

    it("uses initial add-folder copy when the project has no folders", () => {
      const editingProject = makeEditingProject({
        workingDirs: [],
        projectWorkspaces: [],
      });

      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={editingProject}
        />,
      );

      expect(
        screen.getByRole("button", { name: "Add a folder" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Add another folder" }),
      ).not.toBeInTheDocument();
    });

    it("replaces a project folder directly from the native folder picker", async () => {
      const user = userEvent.setup();
      vi.mocked(openDialog).mockResolvedValue("/home/user/other");
      gitMocks.getGitState.mockImplementation(async (path: string) =>
        gitStateForPath(path),
      );
      const workspace = {
        id: "path:/home/user/code",
        path: "/home/user/code",
        kind: "git-main-worktree" as const,
        source: "selected" as const,
        branch: "main",
        repositoryPath: "/home/user/code",
        worktreePath: "/home/user/code",
        usedByAgent: false,
        startupMode: "worktree" as const,
      };
      const secondaryWorkspace = {
        id: "path:/home/user/docs",
        path: "/home/user/docs",
        kind: "git-main-worktree" as const,
        source: "selected" as const,
        branch: "main",
        repositoryPath: "/home/user/docs",
        worktreePath: "/home/user/docs",
        usedByAgent: false,
        startupMode: "none" as const,
      };
      const editingProject = makeEditingProject({
        workingDirs: [workspace.path, secondaryWorkspace.path],
        projectWorkspaces: [workspace, secondaryWorkspace],
      });

      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={editingProject}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Edit code" }));
      await waitFor(() =>
        expect(openDialog).toHaveBeenCalledWith(
          expect.objectContaining({
            defaultPath: "/home/user/code",
            directory: true,
            multiple: false,
          }),
        ),
      );
      expect(
        await screen.findByRole("button", { name: "Edit other" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Edit code" }),
      ).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(updateProject).toHaveBeenCalledOnce());
      expect(vi.mocked(updateProject).mock.calls[0][1].workingDirs).toEqual([
        "/home/user/other",
        "/home/user/docs",
      ]);
      expect(
        vi.mocked(updateProject).mock.calls[0][1].projectWorkspaces,
      ).toEqual([
        expect.objectContaining({
          path: "/home/user/other",
          startupMode: "none",
        }),
        expect.objectContaining({
          path: "/home/user/docs",
          startupMode: "none",
        }),
      ]);
    });

    it("shows the new worktree policies with no branch option", async () => {
      const user = userEvent.setup();
      const workspace = {
        id: "path:/home/user/code",
        path: "/home/user/code",
        kind: "git-main-worktree" as const,
        source: "selected" as const,
        branch: "main",
        repositoryPath: "/home/user/code",
        worktreePath: "/home/user/code",
        usedByAgent: false,
        startupMode: "none" as const,
      };

      render(
        <CreateProjectDialog
          {...defaultProps}
          editingProject={makeEditingProject({
            workingDirs: [workspace.path],
            projectWorkspaces: [workspace],
          })}
        />,
      );

      const policySelect = screen.getByRole("combobox", {
        name: /new chat behavior for code/i,
      });
      expect(policySelect).toHaveTextContent("Configure new chats");

      await user.click(policySelect);
      expect(
        await screen.findByRole("option", {
          name: "Manually create worktrees",
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("option", {
          name: "Auto-create worktrees",
        }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("option", { name: "Don’t create worktrees" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("option", { name: /branch/i }),
      ).not.toBeInTheDocument();
    });

    it("keeps worktree policy when Git inspection temporarily fails", async () => {
      const user = userEvent.setup();
      gitMocks.getGitState.mockRejectedValueOnce(new Error("Git unavailable"));
      const workspace = {
        id: "path:/home/user/code",
        path: "/home/user/code",
        kind: "git-main-worktree" as const,
        source: "selected" as const,
        branch: "main",
        repositoryPath: "/home/user/code",
        worktreePath: "/home/user/code",
        usedByAgent: false,
        startupMode: "auto-worktree" as const,
      };

      render(
        <CreateProjectDialog
          {...defaultProps}
          editingProject={makeEditingProject({
            workingDirs: [workspace.path],
            projectWorkspaces: [workspace],
          })}
        />,
      );

      await waitFor(() => expect(gitMocks.getGitState).toHaveBeenCalled());
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(updateProject).toHaveBeenCalledOnce());
      expect(
        vi.mocked(updateProject).mock.calls[0][1].projectWorkspaces,
      ).toEqual([expect.objectContaining({ startupMode: "auto-worktree" })]);
    });

    it("syncs auto-worktree policy across folders in the same repository", async () => {
      const user = userEvent.setup();
      const workspaces = ["api", "web"].map((name) => ({
        id: `path:/home/user/code/${name}`,
        path: `/home/user/code/${name}`,
        kind: "subdirectory" as const,
        source: "selected" as const,
        branch: "main",
        repositoryPath: "/home/user/code",
        worktreePath: "/home/user/code",
        usedByAgent: false,
        startupMode: "ask-worktree" as const,
      }));

      render(
        <CreateProjectDialog
          {...defaultProps}
          editingProject={makeEditingProject({
            workingDirs: workspaces.map(({ path }) => path),
            projectWorkspaces: workspaces,
          })}
        />,
      );

      await user.click(
        screen.getByRole("combobox", { name: /new chat behavior for api/i }),
      );
      await user.click(
        await screen.findByRole("option", { name: "Auto-create worktrees" }),
      );
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(updateProject).toHaveBeenCalledOnce());
      expect(
        vi.mocked(updateProject).mock.calls[0][1].projectWorkspaces,
      ).toEqual([
        expect.objectContaining({
          path: workspaces[0].path,
          startupMode: "auto-worktree",
        }),
        expect.objectContaining({
          path: workspaces[1].path,
          startupMode: "auto-worktree",
        }),
      ]);
    });

    it("does not sync policy across different repositories", async () => {
      const user = userEvent.setup();
      const workspaces = ["api", "web"].map((name) => ({
        id: `path:/home/user/${name}`,
        path: `/home/user/${name}`,
        kind: "git-main-worktree" as const,
        source: "selected" as const,
        branch: "main",
        repositoryPath: `/home/user/${name}`,
        worktreePath: `/home/user/${name}`,
        usedByAgent: false,
        startupMode: "ask-worktree" as const,
      }));

      render(
        <CreateProjectDialog
          {...defaultProps}
          editingProject={makeEditingProject({
            workingDirs: workspaces.map(({ path }) => path),
            projectWorkspaces: workspaces,
          })}
        />,
      );

      await user.click(
        screen.getByRole("combobox", { name: /new chat behavior for api/i }),
      );
      await user.click(
        await screen.findByRole("option", { name: "Auto-create worktrees" }),
      );
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(updateProject).toHaveBeenCalledOnce());
      expect(
        vi.mocked(updateProject).mock.calls[0][1].projectWorkspaces,
      ).toEqual([
        expect.objectContaining({
          path: workspaces[0].path,
          startupMode: "auto-worktree",
        }),
        expect.objectContaining({
          path: workspaces[1].path,
          startupMode: "ask-worktree",
        }),
      ]);
    });

    it("saves the selected auto-worktree policy", async () => {
      const user = userEvent.setup();
      const workspace = {
        id: "path:/home/user/code",
        path: "/home/user/code",
        kind: "git-main-worktree" as const,
        source: "selected" as const,
        branch: "main",
        repositoryPath: "/home/user/code",
        worktreePath: "/home/user/code",
        usedByAgent: false,
        startupMode: "none" as const,
      };

      render(
        <CreateProjectDialog
          {...defaultProps}
          editingProject={makeEditingProject({
            workingDirs: [workspace.path],
            projectWorkspaces: [workspace],
          })}
        />,
      );

      await user.click(
        screen.getByRole("combobox", {
          name: /new chat behavior for code/i,
        }),
      );
      await user.click(
        await screen.findByRole("option", {
          name: "Auto-create worktrees",
        }),
      );
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(updateProject).toHaveBeenCalledOnce());
      expect(
        vi.mocked(updateProject).mock.calls[0][1].projectWorkspaces,
      ).toEqual([
        expect.objectContaining({
          path: "/home/user/code",
          startupMode: "auto-worktree",
        }),
      ]);
    });

    it("hides and clears workspace policy for non-Git directories", async () => {
      const user = userEvent.setup();
      gitMocks.getGitState.mockResolvedValue({
        isGitRepo: false,
        currentBranch: null,
        dirtyFileCount: 0,
        incomingCommitCount: 0,
        worktrees: [],
        isWorktree: false,
        mainWorktreePath: null,
        localBranches: [],
      });
      const nonGitWorkspace = {
        id: "path:/home/user/documents",
        path: "/home/user/documents",
        kind: "directory" as const,
        source: "selected" as const,
        branch: null,
        usedByAgent: false,
        startupMode: "worktree" as const,
      };
      const editingProject = makeEditingProject({
        workingDirs: [nonGitWorkspace.path],
        projectWorkspaces: [nonGitWorkspace],
      });

      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={editingProject}
        />,
      );

      await waitFor(() => expect(gitMocks.getGitState).toHaveBeenCalled());
      expect(
        screen.queryByRole("combobox", {
          name: /new chat behavior for documents/i,
        }),
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(updateProject).toHaveBeenCalledOnce());
      expect(
        vi.mocked(updateProject).mock.calls[0][1].projectWorkspaces,
      ).toEqual([
        expect.objectContaining({
          path: "/home/user/documents",
          startupMode: "none",
        }),
      ]);
    });

    it("renders a simple folder row without git metadata", async () => {
      gitMocks.getGitState.mockResolvedValue(
        gitStateForPath("/home/user/Development/cash-server"),
      );
      const workspace = {
        id: "path:/home/user/wt/cash-server-feature/packages/builderbot",
        path: "/home/user/wt/cash-server-feature/packages/builderbot",
        kind: "subdirectory" as const,
        source: "selected" as const,
        branch: "feature/builderbot",
        repositoryPath: "/home/user/Development/cash-server",
        worktreePath: "/home/user/wt/cash-server-feature",
        usedByAgent: false,
        startupMode: "worktree" as const,
      };
      const editingProject = makeEditingProject({
        workingDirs: [workspace.path],
        projectWorkspaces: [workspace],
      });

      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={editingProject}
        />,
      );

      expect(
        await screen.findByText("cash-server/.../builderbot"),
      ).toBeInTheDocument();
      expect(screen.queryByText("cash-server-feature")).not.toBeInTheDocument();
      expect(screen.queryByText("feature/builderbot")).not.toBeInTheDocument();
      expect(document.querySelector(".lucide-folder-git")).toBeInTheDocument();
      expect(document.querySelector(".lucide-folder")).not.toBeInTheDocument();
      expect(
        document.querySelector(".lucide-folder-git")?.closest("button"),
      ).toHaveAttribute("aria-label");
      expect(screen.getByText("Project folders")).toBeInTheDocument();
    });

    it("preserves description metadata while saving prompt changes", async () => {
      const user = userEvent.setup();
      const editingProject = makeEditingProject({
        description: "Existing metadata",
        prompt: "Old prompt",
        workingDirs: [],
      });

      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={editingProject}
        />,
      );

      const textarea = screen.getByPlaceholderText(
        "Goals, context, instructions, links to docs…",
      );
      await user.clear(textarea);
      await user.type(textarea, "Updated prompt");
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      expect(updateProject).toHaveBeenCalledWith(
        editingProject,
        expect.objectContaining({
          description: "Existing metadata",
          prompt: "Updated prompt",
        }),
      );
    });

    it("preserves hidden workspaces when saving with multi-workspace disabled", async () => {
      setMultiWorkspaceEnabled(false);
      const user = userEvent.setup();
      const primaryWorkspace = {
        id: "path:/home/user/code",
        path: "/home/user/code",
        kind: "git-main-worktree" as const,
        source: "inferred" as const,
        branch: "main",
        usedByAgent: false,
        startupMode: "none" as const,
      };
      const hiddenWorkspace = {
        id: "path:/home/user/other",
        path: "/home/user/other",
        kind: "git-linked-worktree" as const,
        source: "selected" as const,
        branch: "feature",
        repositoryPath: "/home/user/code",
        worktreePath: "/home/user/other",
        usedByAgent: false,
        startupMode: "worktree" as const,
      };
      const editingProject = makeEditingProject({
        workingDirs: [primaryWorkspace.path, hiddenWorkspace.path],
        projectWorkspaces: [primaryWorkspace, hiddenWorkspace],
      });

      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={editingProject}
        />,
      );

      const nameInput = screen.getByPlaceholderText("Project Alpha");
      await user.clear(nameInput);
      await user.type(nameInput, "Renamed Project");
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(updateProject).toHaveBeenCalledOnce());
      expect(updateProject).toHaveBeenCalledWith(
        editingProject,
        expect.objectContaining({
          workingDirs: [primaryWorkspace.path, hiddenWorkspace.path],
          projectWorkspaces: [primaryWorkspace, hiddenWorkspace],
        }),
      );
    });
  });

  describe("missing folder warning", () => {
    it("does not show a warning when all folders exist", async () => {
      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={makeEditingProject({
            workingDirs: ["/home/user/code"],
          })}
        />,
      );

      await waitFor(() =>
        expect(checkDirectoriesExist).toHaveBeenCalledWith(["/home/user/code"]),
      );
      expect(
        screen.queryByRole("button", {
          name: /no longer exists or isn't accessible/,
        }),
      ).not.toBeInTheDocument();
    });

    it("shows a warning naming the missing folder", async () => {
      vi.mocked(checkDirectoriesExist).mockResolvedValue(["/home/user/gone"]);

      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={makeEditingProject({
            workingDirs: ["/home/user/gone"],
          })}
        />,
      );

      const warning = await screen.findByRole("button", {
        name: "This folder no longer exists or isn't accessible:",
      });
      expect(warning).toBeInTheDocument();
    });

    it("uses the plural message and lists every missing folder", async () => {
      vi.mocked(checkDirectoriesExist).mockResolvedValue([
        "/home/user/gone",
        "/home/user/also-gone",
      ]);

      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={makeEditingProject({
            workingDirs: ["/home/user/gone", "/home/user/also-gone"],
          })}
        />,
      );

      expect(
        await screen.findByRole("button", {
          name: "These folders no longer exist or aren't accessible:",
        }),
      ).toBeInTheDocument();
    });
  });

  describe("color picker", () => {
    it("exposes the 'Choose a project color' swatches", () => {
      render(<CreateProjectDialog {...defaultProps} isOpen={true} />);

      expect(
        screen.getByRole("group", { name: "Choose a project color" }),
      ).toBeInTheDocument();
    });
  });
});
