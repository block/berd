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
import { MULTI_WORKSPACE_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { setExperimentEnabled } from "@/features/experiments/experimentPreferences";

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
      startupMode: "none" | "branch" | "worktree" = "none",
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
  normalizeProjectWorkspaces: vi.fn(
    (
      workspaces:
        | Array<{
            path: string;
            startupMode?: "none" | "branch" | "worktree";
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
        startupMode: useWorktrees ? "worktree" : "none",
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
    vi.mocked(openDialog).mockResolvedValue(null);
    gitMocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "main",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [{ path: "/home/user/code", branch: "main", isMain: true }],
      isWorktree: false,
      mainWorktreePath: "/home/user/code",
      localBranches: ["main"],
    });
    vi.mocked(resolvePath).mockImplementation(async ({ parts }) => ({
      path: parts[0],
    }));
    vi.mocked(checkDirectoriesExist).mockResolvedValue([]);
  });

  describe("form populates on open", () => {
    it("populates the name field when opening with an editingProject", () => {
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
    });

    it("shows Edit project title when editingProject is provided", () => {
      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={makeEditingProject()}
        />,
      );

      expect(screen.getByText("Edit project")).toBeInTheDocument();
    });

    it("shows Create a project title without editingProject", () => {
      render(<CreateProjectDialog {...defaultProps} isOpen={true} />);

      expect(screen.getByText("Create a project")).toBeInTheDocument();
    });

    it("populates the prompt textarea when editing", () => {
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
        "Describe your project, goals, subject etc",
      );
      expect(textarea).toHaveValue("Goal of this project");
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
        "Describe your project, goals, subject etc",
      );
      expect(textarea).toHaveValue("Beta goal");
    });
  });

  describe("create mode", () => {
    it("uses initialWorkingDir to derive project name", () => {
      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          initialWorkingDir="/home/user/my-repo"
        />,
      );

      const nameInput = screen.getByPlaceholderText("Project Alpha");
      expect(nameInput).toHaveValue("my-repo");
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
          "Describe your project, goals, subject etc",
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
            startupMode: "worktree",
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
          startupMode: "worktree",
        }),
        expect.objectContaining({
          path: "/home/user/docs",
          startupMode: "none",
        }),
      ]);
    });

    it("uses the destination repo policy when replacing a project folder", async () => {
      const user = userEvent.setup();
      vi.mocked(openDialog).mockResolvedValue("/home/user/code/web");
      gitMocks.getGitState.mockImplementation(async (path: string) => {
        const repositoryPath = path.startsWith("/home/user/code")
          ? "/home/user/code"
          : path;
        return {
          isGitRepo: true,
          currentBranch: "main",
          dirtyFileCount: 0,
          incomingCommitCount: 0,
          worktrees: [{ path: repositoryPath, branch: "main", isMain: true }],
          isWorktree: false,
          mainWorktreePath: repositoryPath,
          localBranches: ["main"],
        };
      });
      const existingRepoWorkspace = {
        id: "path:/home/user/code/api",
        path: "/home/user/code/api",
        kind: "subdirectory" as const,
        source: "selected" as const,
        branch: "main",
        repositoryPath: "/home/user/code",
        worktreePath: "/home/user/code",
        usedByAgent: false,
        startupMode: "branch" as const,
      };
      const editedWorkspace = {
        id: "path:/home/user/old",
        path: "/home/user/old",
        kind: "git-main-worktree" as const,
        source: "selected" as const,
        branch: "main",
        repositoryPath: "/home/user/old",
        worktreePath: "/home/user/old",
        usedByAgent: false,
        startupMode: "worktree" as const,
      };
      const editingProject = makeEditingProject({
        workingDirs: [existingRepoWorkspace.path, editedWorkspace.path],
        projectWorkspaces: [existingRepoWorkspace, editedWorkspace],
      });

      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={editingProject}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Edit old" }));
      expect(
        await screen.findByRole("button", { name: "Edit web" }),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(updateProject).toHaveBeenCalledOnce());
      expect(
        vi.mocked(updateProject).mock.calls[0][1].projectWorkspaces,
      ).toEqual([
        expect.objectContaining({
          path: "/home/user/code/api",
          startupMode: "branch",
        }),
        expect.objectContaining({
          path: "/home/user/code/web",
          startupMode: "branch",
        }),
      ]);
    });

    it("confirms before using a linked worktree folder to create new worktrees", async () => {
      const user = userEvent.setup();
      const linkedWorktreeWorkspace = {
        id: "path:/home/user/code-feature/service",
        path: "/home/user/code-feature/service",
        kind: "subdirectory" as const,
        source: "selected" as const,
        branch: "feature",
        repositoryPath: "/home/user/code",
        worktreePath: "/home/user/code-feature",
        usedByAgent: false,
        startupMode: "none" as const,
      };
      const editingProject = makeEditingProject({
        workingDirs: [linkedWorktreeWorkspace.path],
        projectWorkspaces: [linkedWorktreeWorkspace],
      });

      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={editingProject}
        />,
      );

      const policySelect = screen.getByRole("combobox", {
        name: /new chat behavior for service/i,
      });
      await user.click(policySelect);
      await user.click(
        await screen.findByRole("option", { name: "Create worktree" }),
      );

      expect(
        await screen.findByRole("dialog", {
          name: "Create a different worktree?",
        }),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Create worktree" }));
      expect(
        screen.getByRole("combobox", {
          name: /new chat behavior for service/i,
        }),
      ).toHaveTextContent("Create worktree");
    });

    it("defaults a new workspace to the existing policy for the same repo", async () => {
      const user = userEvent.setup();
      vi.mocked(openDialog).mockResolvedValue("/home/user/newcode");
      gitMocks.getGitState.mockResolvedValue(
        gitStateForPath("/home/user/newcode"),
      );
      const existingWorkspace = {
        id: "path:/home/user/newcode/api",
        path: "/home/user/newcode/api",
        kind: "subdirectory" as const,
        source: "selected" as const,
        branch: "main",
        repositoryPath: "/home/user/newcode",
        worktreePath: "/home/user/newcode",
        usedByAgent: false,
        startupMode: "branch" as const,
      };
      const editingProject = makeEditingProject({
        workingDirs: [existingWorkspace.path],
        projectWorkspaces: [existingWorkspace],
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
      expect(
        await screen.findByRole("button", { name: "Edit newcode" }),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(updateProject).toHaveBeenCalledOnce());
      expect(
        vi.mocked(updateProject).mock.calls[0][1].projectWorkspaces,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "/home/user/newcode",
            startupMode: "branch",
          }),
        ]),
      );
    });

    it("does not inherit branch policy from a different worktree of the same repo", async () => {
      const user = userEvent.setup();
      vi.mocked(openDialog).mockResolvedValue("/home/user/code-other/web");
      gitMocks.getGitState.mockResolvedValue({
        isGitRepo: true,
        currentBranch: "other",
        dirtyFileCount: 0,
        incomingCommitCount: 0,
        worktrees: [
          { path: "/home/user/code", branch: "main", isMain: true },
          { path: "/home/user/code-feature", branch: "feature", isMain: false },
          { path: "/home/user/code-other", branch: "other", isMain: false },
        ],
        isWorktree: true,
        mainWorktreePath: "/home/user/code",
        localBranches: ["main", "feature", "other"],
      });
      const existingWorkspace = {
        id: "path:/home/user/code-feature/api",
        path: "/home/user/code-feature/api",
        kind: "subdirectory" as const,
        source: "selected" as const,
        branch: "feature",
        repositoryPath: "/home/user/code",
        worktreePath: "/home/user/code-feature",
        usedByAgent: false,
        startupMode: "branch" as const,
      };
      const editingProject = makeEditingProject({
        workingDirs: [existingWorkspace.path],
        projectWorkspaces: [existingWorkspace],
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
      expect(
        await screen.findByRole("button", { name: "Edit web" }),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(updateProject).toHaveBeenCalledOnce());
      expect(
        vi.mocked(updateProject).mock.calls[0][1].projectWorkspaces,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "/home/user/code-feature/api",
            startupMode: "branch",
          }),
          expect.objectContaining({
            path: "/home/user/code-other/web",
            startupMode: "none",
          }),
        ]),
      );
    });

    it("does not preserve branch policy when replacing a folder with a different worktree", async () => {
      const user = userEvent.setup();
      vi.mocked(openDialog).mockResolvedValue("/home/user/code-other/web");
      gitMocks.getGitState.mockResolvedValue({
        isGitRepo: true,
        currentBranch: "other",
        dirtyFileCount: 0,
        incomingCommitCount: 0,
        worktrees: [
          { path: "/home/user/code", branch: "main", isMain: true },
          { path: "/home/user/code-feature", branch: "feature", isMain: false },
          { path: "/home/user/code-other", branch: "other", isMain: false },
        ],
        isWorktree: true,
        mainWorktreePath: "/home/user/code",
        localBranches: ["main", "feature", "other"],
      });
      const existingWorkspace = {
        id: "path:/home/user/code-feature/api",
        path: "/home/user/code-feature/api",
        kind: "subdirectory" as const,
        source: "selected" as const,
        branch: "feature",
        repositoryPath: "/home/user/code",
        worktreePath: "/home/user/code-feature",
        usedByAgent: false,
        startupMode: "branch" as const,
      };
      const editedWorkspace = {
        id: "path:/home/user/code-feature/tools",
        path: "/home/user/code-feature/tools",
        kind: "subdirectory" as const,
        source: "selected" as const,
        branch: "feature",
        repositoryPath: "/home/user/code",
        worktreePath: "/home/user/code-feature",
        usedByAgent: false,
        startupMode: "branch" as const,
      };
      const editingProject = makeEditingProject({
        workingDirs: [existingWorkspace.path, editedWorkspace.path],
        projectWorkspaces: [existingWorkspace, editedWorkspace],
      });

      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={editingProject}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Edit tools" }));
      expect(
        await screen.findByRole("button", { name: "Edit web" }),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(updateProject).toHaveBeenCalledOnce());
      expect(
        vi.mocked(updateProject).mock.calls[0][1].projectWorkspaces,
      ).toEqual([
        expect.objectContaining({
          path: "/home/user/code-feature/api",
          startupMode: "branch",
        }),
        expect.objectContaining({
          path: "/home/user/code-other/web",
          startupMode: "none",
        }),
      ]);
    });

    it("keeps non-none startup policies in sync for folders in the same repo", async () => {
      const user = userEvent.setup();
      const apiWorkspace = {
        id: "path:/home/user/code/api",
        path: "/home/user/code/api",
        kind: "subdirectory" as const,
        source: "selected" as const,
        branch: "main",
        repositoryPath: "/home/user/code",
        worktreePath: "/home/user/code",
        usedByAgent: false,
        startupMode: "worktree" as const,
      };
      const webWorkspace = {
        id: "path:/home/user/code/web",
        path: "/home/user/code/web",
        kind: "subdirectory" as const,
        source: "selected" as const,
        branch: "main",
        repositoryPath: "/home/user/code",
        worktreePath: "/home/user/code",
        usedByAgent: false,
        startupMode: "worktree" as const,
      };
      const editingProject = makeEditingProject({
        workingDirs: [apiWorkspace.path, webWorkspace.path],
        projectWorkspaces: [apiWorkspace, webWorkspace],
      });

      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={editingProject}
        />,
      );

      await user.click(
        screen.getByRole("combobox", {
          name: /new chat behavior for api/i,
        }),
      );
      await user.click(
        await screen.findByRole("option", { name: "Create branch" }),
      );
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(updateProject).toHaveBeenCalledOnce());
      expect(
        vi.mocked(updateProject).mock.calls[0][1].projectWorkspaces,
      ).toEqual([
        expect.objectContaining({
          path: "/home/user/code/api",
          startupMode: "branch",
        }),
        expect.objectContaining({
          path: "/home/user/code/web",
          startupMode: "branch",
        }),
      ]);
    });

    it("does not sync branch startup policies across different worktrees of the same repo", async () => {
      const user = userEvent.setup();
      const apiWorkspace = {
        id: "path:/home/user/code-feature/api",
        path: "/home/user/code-feature/api",
        kind: "subdirectory" as const,
        source: "selected" as const,
        branch: "feature",
        repositoryPath: "/home/user/code",
        worktreePath: "/home/user/code-feature",
        usedByAgent: false,
        startupMode: "worktree" as const,
      };
      const webWorkspace = {
        id: "path:/home/user/code-other/web",
        path: "/home/user/code-other/web",
        kind: "subdirectory" as const,
        source: "selected" as const,
        branch: "other",
        repositoryPath: "/home/user/code",
        worktreePath: "/home/user/code-other",
        usedByAgent: false,
        startupMode: "worktree" as const,
      };
      const editingProject = makeEditingProject({
        workingDirs: [apiWorkspace.path, webWorkspace.path],
        projectWorkspaces: [apiWorkspace, webWorkspace],
      });

      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={editingProject}
        />,
      );

      await user.click(
        screen.getByRole("combobox", {
          name: /new chat behavior for api/i,
        }),
      );
      await user.click(
        await screen.findByRole("option", { name: "Create branch" }),
      );
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(updateProject).toHaveBeenCalledOnce());
      expect(
        vi.mocked(updateProject).mock.calls[0][1].projectWorkspaces,
      ).toEqual([
        expect.objectContaining({
          path: "/home/user/code-feature/api",
          startupMode: "branch",
        }),
        expect.objectContaining({
          path: "/home/user/code-other/web",
          startupMode: "worktree",
        }),
      ]);
    });

    it("does not preserve branch or worktree policy for non-git directories", async () => {
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

    it("renders workspace titles and git root context like chat workspace rows", async () => {
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
      expect(screen.getByText("cash-server-feature")).toBeInTheDocument();
      expect(screen.getByText("Project folders")).toBeInTheDocument();
      expect(screen.getByText("When starting a new chat")).toBeInTheDocument();
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
        "Describe your project, goals, subject etc",
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
      setExperimentEnabled(MULTI_WORKSPACE_EXPERIMENT_ID, false);
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
