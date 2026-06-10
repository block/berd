import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import type { ProjectInfo } from "../../api/projects";
import {
  createProject,
  scanProjectIcons,
  updateProject,
} from "../../api/projects";
import { checkDirectoriesExist, resolvePath } from "@/shared/api/pathResolver";
import { discoverAcpProviders } from "@/shared/api/acp";
import { CreateProjectDialog } from "../CreateProjectDialog";

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

vi.mock("@/shared/api/acp", () => ({
  discoverAcpProviders: vi.fn().mockResolvedValue([]),
}));

const providerStatusMocks = vi.hoisted(() => ({
  readyAgentIds: new Set<string>(),
}));

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: providerStatusMocks.readyAgentIds,
    agentReadiness: new Map(),
    agentChecks: new Map(),
    loading: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/shared/api/system", () => ({
  getHomeDir: vi.fn().mockResolvedValue("/home/user"),
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
    preferredProvider: null,
    preferredModel: null,
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
    preferredProvider: null,
    preferredModel: null,
    workingDirs: [],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
  }),
  scanProjectIcons: vi.fn().mockResolvedValue([]),
  readProjectIcon: vi.fn().mockResolvedValue({
    icon: "data:image/png;base64,aWNvbg==",
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
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
    preferredProvider: null,
    preferredModel: null,
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

// ── Tests ─────────────────────────────────────────────────────────────

describe("CreateProjectDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerStatusMocks.readyAgentIds = new Set<string>();
    vi.mocked(open).mockResolvedValue(null);
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
        null,
        null,
        [],
        false,
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

    it("replaces the working directory when a new folder is picked", async () => {
      const user = userEvent.setup();
      const editingProject = makeEditingProject({
        workingDirs: ["/home/user/code"],
      });
      vi.mocked(open).mockResolvedValue("/home/user/newcode");

      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={editingProject}
        />,
      );

      await user.click(screen.getByRole("button", { name: "code" }));
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(updateProject).toHaveBeenCalledOnce());
      const savedWorkingDirs =
        vi.mocked(updateProject).mock.calls[0][1].workingDirs ?? [];
      expect(savedWorkingDirs[0]).toBe("/home/user/newcode");
      expect(savedWorkingDirs).not.toContain("/home/user/code");
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

  describe("provider selection", () => {
    it("only shows ready ACP providers in the project default dropdown", async () => {
      const user = userEvent.setup();
      vi.mocked(discoverAcpProviders).mockResolvedValue([
        { id: "goose", label: "Goose" },
        { id: "claude-acp", label: "Claude Code" },
        { id: "copilot-acp", label: "Copilot" },
        { id: "cursor-agent", label: "Cursor Agent" },
      ]);
      providerStatusMocks.readyAgentIds = new Set<string>([
        "goose",
        "claude-acp",
      ]);

      render(<CreateProjectDialog {...defaultProps} isOpen={true} />);

      await user.click(screen.getByRole("combobox"));

      expect(
        await screen.findByRole("option", { name: "Goose" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: "Claude Code" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("option", { name: "Copilot" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("option", { name: "Cursor Agent" }),
      ).not.toBeInTheDocument();
    });

    it("keeps a saved preferred provider visible even if it is not currently ready", async () => {
      const user = userEvent.setup();
      vi.mocked(discoverAcpProviders).mockResolvedValue([
        { id: "goose", label: "Goose" },
        { id: "cursor-agent", label: "Cursor Agent" },
      ]);
      providerStatusMocks.readyAgentIds = new Set<string>(["goose"]);

      render(
        <CreateProjectDialog
          {...defaultProps}
          isOpen={true}
          editingProject={makeEditingProject({
            preferredProvider: "cursor-agent",
          })}
        />,
      );

      await user.click(screen.getByRole("combobox"));

      expect(
        await screen.findByRole("option", { name: "Goose" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: "Cursor Agent" }),
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
