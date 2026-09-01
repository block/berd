import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  TopBarActionsProvider,
  useTopBarActions,
} from "@/app/contexts/TopBarActionsContext";
import { resetHomeWidgetStoreForTests } from "@/features/home/stores/homeWidgetStore";
import type { SkillInfo } from "../../api/skills";
import { SKILL_DISCOVERY_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { SkillsView } from "../SkillsView";

const mockRevealInFileManager = vi.hoisted(() => vi.fn());
const mockReducedMotion = vi.hoisted(() => ({ value: false }));

vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return {
    ...actual,
    useReducedMotion: () => mockReducedMotion.value,
  };
});

type MockProject = {
  id: string;
  name: string;
  workingDirs: string[];
};

let mockProjects: MockProject[] = [
  {
    id: "project-alpha",
    name: "alpha",
    workingDirs: ["/tmp/alpha"],
  },
];

const mockSkills: SkillInfo[] = [
  {
    id: "global:/path/layout-polish",
    name: "layout",
    description: "Improves layout, spacing, and visual hierarchy",
    instructions: "Refine spacing and visual rhythm...",
    path: "/path/layout/SKILL.md",
    fileLocation: "/path/layout/SKILL.md",
    sourceKind: "global" as const,
    sourceLabel: "Personal",
    projectLinks: [],
    readonly: false,
    color: null,
  },
  {
    id: "global:/path/code-review",
    name: "code-review",
    description: "Reviews code",
    instructions: "Review the code...",
    path: "/path/code-review",
    fileLocation: "/path/code-review/SKILL.md",
    sourceKind: "global" as const,
    sourceLabel: "Personal",
    projectLinks: [],
    readonly: false,
    color: null,
  },
  {
    id: "project:/tmp/alpha/.goose/skills/test-writer",
    name: "test-writer",
    description: "Writes tests",
    instructions: "Write tests...",
    path: "/tmp/alpha/.goose/skills/test-writer",
    fileLocation: "/tmp/alpha/.goose/skills/test-writer/SKILL.md",
    sourceKind: "project" as const,
    sourceLabel: "alpha",
    readonly: false,
    color: null,
    projectLinks: [
      {
        id: "/tmp/alpha",
        name: "alpha",
        workingDir: "/tmp/alpha",
        path: "/tmp/alpha/.goose/skills/test-writer",
        fileLocation: "/tmp/alpha/.goose/skills/test-writer/SKILL.md",
      },
    ],
  },
];

const builtinSkill: SkillInfo = {
  id: "builtin:goose-doc-guide",
  name: "goose-doc-guide",
  description: "Reference Goose documentation",
  instructions: "Fetch Goose docs before answering.",
  path: "builtin://skills/goose-doc-guide",
  fileLocation: "builtin://skills/goose-doc-guide",
  sourceKind: "builtin" as const,
  sourceLabel: "Built in",
  projectLinks: [],
  readonly: true,
  color: null,
};

vi.mock("../../api/skills", () => ({
  listSkills: vi.fn().mockResolvedValue([]),
  createSkill: vi.fn().mockResolvedValue(undefined),
  updateSkill: vi.fn().mockResolvedValue({
    id: "global:/path/renamed-review",
    name: "renamed-review",
    description: "Reviews code",
    instructions: "Review the code...",
    path: "/path/renamed-review",
    fileLocation: "/path/renamed-review/SKILL.md",
    sourceKind: "global",
    sourceLabel: "Personal",
    projectLinks: [],
    readonly: false,
  }),
  deleteSkill: vi.fn().mockResolvedValue(undefined),
  exportSkill: vi
    .fn()
    .mockResolvedValue({ json: "{}", filename: "test.skill.json" }),
  importSkills: vi.fn().mockResolvedValue([]),
  isSkillImportFileName: (fileName: string) =>
    fileName.toLowerCase().endsWith(".json"),
}));

vi.mock("@/features/projects/stores/projectStore", () => ({
  useProjectStore: (
    selector: (state: { projects: MockProject[] }) => unknown,
  ) => selector({ projects: mockProjects }),
}));

vi.mock("@/shared/lib/fileManager", () => ({
  revealInFileManager: mockRevealInFileManager,
}));

const mockDiscoveryExperimentEnabled = vi.hoisted(() => ({ value: false }));
const mockUseExperiment = vi.hoisted(() => vi.fn());
vi.mock("@/features/experiments/experimentPreferences", () => ({
  useExperiment: mockUseExperiment,
  subscribeToExperimentChanges: () => () => {},
}));

const mockRemoteSkillsState = vi.hoisted(() => ({
  value: {
    cliState: "available" as const,
    skills: [] as unknown[],
    loading: false,
    catalogState: "ready",
    installing: new Set<string>(),
    reload: vi.fn(),
    install: vi.fn(),
  },
}));
vi.mock("../../hooks/useRemoteSkills", () => ({
  useRemoteSkills: () => mockRemoteSkillsState.value,
}));

vi.mock("../RemoteSkillDetailPage", () => ({
  RemoteSkillDetailPage: ({ skill }: { skill: { name: string } }) => (
    <div data-testid="remote-skill-detail">{skill.name}</div>
  ),
}));

const { listSkills, deleteSkill, updateSkill, exportSkill } = (await import(
  "../../api/skills"
)) as unknown as {
  listSkills: ReturnType<typeof vi.fn>;
  deleteSkill: ReturnType<typeof vi.fn>;
  updateSkill: ReturnType<typeof vi.fn>;
  exportSkill: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  resetHomeWidgetStoreForTests();
  vi.clearAllMocks();
  mockDiscoveryExperimentEnabled.value = false;
  mockReducedMotion.value = false;
  mockUseExperiment.mockImplementation((id: string) =>
    id === SKILL_DISCOVERY_EXPERIMENT_ID
      ? { enabled: mockDiscoveryExperimentEnabled.value }
      : null,
  );
  mockRemoteSkillsState.value = {
    cliState: "available",
    skills: [],
    loading: false,
    catalogState: "ready",
    installing: new Set<string>(),
    reload: vi.fn(),
    install: vi.fn(),
  };
  mockProjects = [
    {
      id: "project-alpha",
      name: "alpha",
      workingDirs: ["/tmp/alpha"],
    },
  ];
  listSkills.mockResolvedValue([]);
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function TopBarActionsHost() {
  const actions = useTopBarActions();
  return <div>{actions}</div>;
}

function renderSkillsViewWithTopBarActions(
  props?: ComponentProps<typeof SkillsView>,
) {
  return render(
    <TopBarActionsProvider>
      <TopBarActionsHost />
      <SkillsView {...props} />
    </TopBarActionsProvider>,
  );
}

describe("SkillsView", () => {
  it("renders the inline create tile even when no skills are present", async () => {
    render(<SkillsView />);
    await waitFor(() => {
      expect(listSkills).toHaveBeenCalledWith(["/tmp/alpha"]);
    });
    // The grid always renders the inline "+" create tile; there is no
    // longer a dedicated empty state copy.
    const createTiles = await screen.findAllByRole("button", {
      name: "New skill",
    });
    expect(createTiles.length).toBeGreaterThan(0);
  });

  it("hides tab semantics when the skill-discovery experiment is off", async () => {
    mockDiscoveryExperimentEnabled.value = false;
    listSkills.mockResolvedValue(mockSkills);
    renderSkillsViewWithTopBarActions();

    expect(await screen.findByText("code-review")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("tabpanel")).toBeNull();
  });

  it("shows the installed/discover tabs when the experiment is on", async () => {
    mockDiscoveryExperimentEnabled.value = true;
    renderSkillsViewWithTopBarActions();
    await waitFor(() => {
      expect(listSkills).toHaveBeenCalled();
    });
    const installedTab = await screen.findByRole("tab", {
      name: /Installed, 0/,
    });
    const discoverTab = screen.getByRole("tab", { name: /Discover, 0/ });
    expect(installedTab).toBeInTheDocument();
    expect(discoverTab).toBeInTheDocument();
    expect(
      document.getElementById(installedTab.getAttribute("aria-controls") ?? ""),
    ).toHaveAttribute("role", "tabpanel");
    expect(
      document.getElementById(discoverTab.getAttribute("aria-controls") ?? ""),
    ).toHaveAttribute("role", "tabpanel");
  });

  it("returns to Installed when discovery is disabled", async () => {
    mockDiscoveryExperimentEnabled.value = true;
    listSkills.mockResolvedValue(mockSkills);
    const { rerender } = renderSkillsViewWithTopBarActions();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("tab", { name: /Discover/ }));
    mockDiscoveryExperimentEnabled.value = false;
    rerender(
      <TopBarActionsProvider>
        <TopBarActionsHost />
        <SkillsView />
      </TopBarActionsProvider>,
    );

    expect(await screen.findByText("code-review")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Discover/ })).toBeNull();
  });

  it("resolves a remote detail route by name from the catalog", async () => {
    mockDiscoveryExperimentEnabled.value = true;
    mockRemoteSkillsState.value = {
      cliState: "available",
      skills: [
        {
          name: "agent-browser",
          description: "Debug visual bugs",
          roles: [],
          references: [],
          author: null,
          status: null,
          installed: false,
        },
      ],
      loading: false,
      catalogState: "ready",
      installing: new Set<string>(),
      reload: vi.fn(),
      install: vi.fn(),
    };
    renderSkillsViewWithTopBarActions({
      activeSkillId: "remote:agent-browser",
    });
    expect(await screen.findByTestId("remote-skill-detail")).toHaveTextContent(
      "agent-browser",
    );
  });

  it("clears a remote detail route that can't resolve after loading", async () => {
    mockDiscoveryExperimentEnabled.value = true;
    mockRemoteSkillsState.value = {
      cliState: "available",
      skills: [],
      loading: false,
      catalogState: "ready",
      installing: new Set<string>(),
      reload: vi.fn(),
      install: vi.fn(),
    };
    const onActiveSkillIdChange = vi.fn();
    renderSkillsViewWithTopBarActions({
      activeSkillId: "remote:missing-skill",
      onActiveSkillIdChange,
    });
    await waitFor(() => {
      expect(onActiveSkillIdChange).toHaveBeenCalledWith(null, {
        replace: true,
      });
    });
  });

  it("ignores stale skill loads after projects change", async () => {
    const firstLoad = createDeferred<typeof mockSkills>();
    const secondLoad = createDeferred<typeof mockSkills>();
    listSkills
      .mockReturnValueOnce(firstLoad.promise)
      .mockReturnValueOnce(secondLoad.promise);
    const { rerender } = render(<SkillsView />);

    await waitFor(() => {
      expect(listSkills).toHaveBeenCalledTimes(1);
    });

    mockProjects = [
      {
        id: "project-beta",
        name: "beta",
        workingDirs: ["/tmp/beta"],
      },
    ];
    rerender(<SkillsView />);

    await waitFor(() => {
      expect(listSkills).toHaveBeenCalledTimes(2);
    });

    secondLoad.resolve([
      {
        ...mockSkills[2],
        id: "project:/tmp/beta/.goose/skills/beta-skill",
        name: "beta-skill",
        path: "/tmp/beta/.goose/skills/beta-skill",
        fileLocation: "/tmp/beta/.goose/skills/beta-skill/SKILL.md",
        sourceLabel: "beta",
        projectLinks: [
          {
            id: "/tmp/beta",
            name: "beta",
            workingDir: "/tmp/beta",
            path: "/tmp/beta/.goose/skills/beta-skill",
            fileLocation: "/tmp/beta/.goose/skills/beta-skill/SKILL.md",
          },
        ],
      },
    ]);
    await screen.findByText("beta-skill");

    firstLoad.resolve([mockSkills[2]]);
    await waitFor(() => {
      expect(screen.getByText("beta-skill")).toBeInTheDocument();
      expect(screen.queryByText("test-writer")).not.toBeInTheDocument();
    });
  });

  it("renders all skills as a flat grid and opens the detail subpage", async () => {
    listSkills.mockResolvedValue(mockSkills);
    const user = userEvent.setup();

    render(<SkillsView />);
    await screen.findByText("code-review");

    // All sources are visible together by default.
    expect(screen.getByText("layout")).toBeInTheDocument();
    expect(screen.getByText("test-writer")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Open test-writer details" }),
    );

    expect(
      screen.getByRole("heading", { name: "test-writer" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Write tests...")).toBeInTheDocument();
    expect(
      screen.getByText("/tmp/alpha/.goose/skills/test-writer/SKILL.md"),
    ).toBeInTheDocument();
  });

  it("staggers the skill grid reveal after loading", async () => {
    listSkills.mockResolvedValue(mockSkills);

    const { container } = render(<SkillsView />);
    await screen.findByText("code-review");

    const revealItems = container.querySelectorAll<HTMLElement>(
      ".gallery-card-enter",
    );
    expect(revealItems).toHaveLength(mockSkills.length + 1);
    expect(revealItems[1]).toHaveStyle({ animationDelay: "55ms" });
    expect(revealItems[2]).toHaveStyle({ animationDelay: "110ms" });
  });

  it("keeps toolbar actions within the wide-screen skill grid", async () => {
    listSkills.mockResolvedValue(mockSkills);

    const { container } = renderSkillsViewWithTopBarActions();
    await screen.findByText("code-review");

    expect(container.querySelector("section")).toHaveClass(
      "mx-auto",
      "w-full",
      "max-w-[70rem]",
    );
  });

  it("filters skills with page-local search", async () => {
    listSkills.mockResolvedValue(mockSkills);
    const user = userEvent.setup();

    renderSkillsViewWithTopBarActions();
    await screen.findByText("code-review");

    await user.click(screen.getByRole("button", { name: "Search skills" }));
    await user.type(
      screen.getByRole("searchbox", { name: "Search skills" }),
      "test",
    );

    expect(screen.getByText("test-writer")).toBeInTheDocument();
    expect(screen.queryByText("layout")).not.toBeInTheDocument();
    expect(screen.queryByText("code-review")).not.toBeInTheDocument();
  });

  it("restores focus to the search action after closing search", async () => {
    listSkills.mockResolvedValue(mockSkills);
    const user = userEvent.setup();

    renderSkillsViewWithTopBarActions();
    await screen.findByText("code-review");

    await user.click(screen.getByRole("button", { name: "Search skills" }));
    const search = screen.getByRole("searchbox", { name: "Search skills" });
    expect(search).toHaveFocus();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Search skills" }),
      ).toHaveFocus();
    });
  });

  it("opens the skill file picker directly from Import", async () => {
    listSkills.mockResolvedValue(mockSkills);
    const user = userEvent.setup();

    const { container } = renderSkillsViewWithTopBarActions();
    await screen.findByText("code-review");
    const input = container.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("Expected the skill import file input");
    }
    const click = vi.spyOn(input, "click");

    await user.click(screen.getByRole("button", { name: "Import" }));

    expect(click).toHaveBeenCalledOnce();
    expect(input).toHaveAttribute(
      "accept",
      ".skill.json,.json,application/json",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("disables the search expansion spring for reduced motion", async () => {
    mockReducedMotion.value = true;
    listSkills.mockResolvedValue(mockSkills);
    const user = userEvent.setup();

    const { container } = renderSkillsViewWithTopBarActions();
    await screen.findByText("code-review");
    await user.click(screen.getByRole("button", { name: "Search skills" }));

    const searchContainer = container.querySelector(
      "[data-search-field-container]",
    );
    expect(searchContainer).toHaveAttribute("data-search-motion", "reduced");
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("labels Discover scope as an install destination", async () => {
    mockDiscoveryExperimentEnabled.value = true;
    listSkills.mockResolvedValue(mockSkills);
    const user = userEvent.setup();

    renderSkillsViewWithTopBarActions();
    await user.click(await screen.findByRole("tab", { name: /Discover/ }));

    const destination = screen.getByRole("button", {
      name: "Choose install destination",
    });
    expect(destination).toHaveTextContent("Personal");
    await user.click(destination);
    expect(
      screen.getByRole("menuitemradio", { name: "Personal" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.queryByRole("menuitemradio", { name: "All" }),
    ).not.toBeInTheDocument();
  });

  it("filters Installed to personal skills", async () => {
    listSkills.mockResolvedValue([...mockSkills, builtinSkill]);
    const user = userEvent.setup();

    renderSkillsViewWithTopBarActions();
    await screen.findByText("test-writer");
    await user.click(
      screen.getByRole("button", { name: "Filter skills by source" }),
    );
    await user.click(screen.getByRole("menuitemradio", { name: "Personal" }));

    expect(screen.getByText("layout")).toBeInTheDocument();
    expect(screen.queryByText("test-writer")).not.toBeInTheDocument();
    expect(screen.queryByText("goose-doc-guide")).not.toBeInTheDocument();
  });

  it("falls back to Personal when a Discover project disappears", async () => {
    mockDiscoveryExperimentEnabled.value = true;
    listSkills.mockResolvedValue(mockSkills);
    const user = userEvent.setup();
    const { rerender } = renderSkillsViewWithTopBarActions();

    await user.click(await screen.findByRole("tab", { name: /Discover/ }));
    await user.click(
      screen.getByRole("button", { name: "Choose install destination" }),
    );
    await user.click(screen.getByRole("menuitemradio", { name: "alpha" }));

    mockProjects = [];
    rerender(
      <TopBarActionsProvider>
        <TopBarActionsHost />
        <SkillsView />
      </TopBarActionsProvider>,
    );

    const destination = await screen.findByRole("button", {
      name: "Choose install destination",
    });
    await waitFor(() => expect(destination).toHaveTextContent("Personal"));
  });

  it("filters skills to a selected project", async () => {
    listSkills.mockResolvedValue(mockSkills);
    const user = userEvent.setup();

    renderSkillsViewWithTopBarActions();
    await screen.findByText("code-review");

    await user.click(
      screen.getByRole("button", { name: "Filter skills by source" }),
    );
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "All" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const projectOption = screen.getByRole("menuitemradio", { name: "alpha" });
    expect(projectOption).toHaveAttribute("aria-checked", "false");
    await user.click(projectOption);

    expect(screen.getByText("test-writer")).toBeInTheDocument();
    expect(screen.queryByText("layout")).not.toBeInTheDocument();
    expect(screen.queryByText("code-review")).not.toBeInTheDocument();
  });

  it("defaults new skills to the Personal destination", async () => {
    listSkills.mockResolvedValue(mockSkills);
    const user = userEvent.setup();

    renderSkillsViewWithTopBarActions();
    await screen.findByText("code-review");
    await user.click(screen.getAllByRole("button", { name: "New skill" })[0]);

    expect(screen.getByRole("combobox")).toHaveTextContent("Personal");
  });

  it("preselects the current project when creating from a project filter", async () => {
    listSkills.mockResolvedValue(mockSkills);
    const user = userEvent.setup();

    renderSkillsViewWithTopBarActions();
    await screen.findByText("code-review");

    await user.click(
      screen.getByRole("button", { name: "Filter skills by source" }),
    );
    await user.click(screen.getByRole("menuitemradio", { name: "alpha" }));
    await user.click(screen.getAllByRole("button", { name: "New skill" })[0]);

    expect(screen.getByRole("combobox")).toHaveTextContent("alpha");
    expect(
      screen.queryByText("Stored in the project folder"),
    ).not.toBeInTheDocument();
  });

  it("uses the selected project copy for merged project skill actions", async () => {
    mockProjects = [
      {
        id: "project-alpha",
        name: "alpha",
        workingDirs: ["/tmp/goose"],
      },
      {
        id: "project-beta",
        name: "beta",
        workingDirs: ["/tmp/goose-worktrees/feature"],
      },
    ];
    const mergedSkill: SkillInfo = {
      ...mockSkills[2],
      id: "project:/tmp/goose/.agents/skills/test-writer",
      path: "/tmp/goose/.agents/skills/test-writer",
      fileLocation: "/tmp/goose/.agents/skills/test-writer/SKILL.md",
      sourceLabel: "alpha",
      projectLinks: [
        {
          id: "project-alpha",
          name: "alpha",
          workingDir: "/tmp/goose",
          path: "/tmp/goose/.agents/skills/test-writer",
          fileLocation: "/tmp/goose/.agents/skills/test-writer/SKILL.md",
        },
        {
          id: "project-beta",
          name: "beta",
          workingDir: "/tmp/goose-worktrees/feature",
          path: "/tmp/goose-worktrees/feature/.agents/skills/test-writer",
          fileLocation:
            "/tmp/goose-worktrees/feature/.agents/skills/test-writer/SKILL.md",
        },
      ],
    };
    listSkills.mockResolvedValue([mergedSkill]);
    const onStartChatWithSkill = vi.fn();
    const user = userEvent.setup();

    renderSkillsViewWithTopBarActions({ onStartChatWithSkill });
    await screen.findByText("test-writer");

    await user.click(
      screen.getByRole("button", { name: "Filter skills by source" }),
    );
    await user.click(screen.getByRole("menuitemradio", { name: "beta" }));
    await user.click(
      screen.getByRole("button", { name: "Open test-writer details" }),
    );

    expect(
      screen.getByText(
        "/tmp/goose-worktrees/feature/.agents/skills/test-writer/SKILL.md",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start chat" }));
    expect(onStartChatWithSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/tmp/goose-worktrees/feature/.agents/skills/test-writer",
        fileLocation:
          "/tmp/goose-worktrees/feature/.agents/skills/test-writer/SKILL.md",
      }),
      "project-beta",
    );

    await user.click(screen.getByRole("button", { name: "Show in folder" }));
    expect(mockRevealInFileManager).toHaveBeenCalledWith(
      "/tmp/goose-worktrees/feature/.agents/skills/test-writer",
    );
  });

  it("uses controlled navigation for skill detail routes", async () => {
    listSkills.mockResolvedValue(mockSkills);
    const onActiveSkillIdChange = vi.fn();
    const user = userEvent.setup();

    const { rerender } = render(
      <SkillsView
        activeSkillId={null}
        onActiveSkillIdChange={onActiveSkillIdChange}
      />,
    );
    await screen.findByText("code-review");

    await user.click(
      screen.getByRole("button", { name: "Open code-review details" }),
    );

    expect(onActiveSkillIdChange).toHaveBeenCalledWith(
      "global:/path/code-review",
      undefined,
    );

    rerender(
      <SkillsView
        activeSkillId="global:/path/code-review"
        onActiveSkillIdChange={onActiveSkillIdChange}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "code-review" }),
    ).toBeInTheDocument();
  });

  it("replaces a missing controlled skill detail with the list route", async () => {
    listSkills.mockResolvedValue(mockSkills);
    const onActiveSkillIdChange = vi.fn();

    render(
      <SkillsView
        activeSkillId="missing-skill"
        onActiveSkillIdChange={onActiveSkillIdChange}
      />,
    );

    await screen.findByText("code-review");

    await waitFor(() => {
      expect(onActiveSkillIdChange).toHaveBeenCalledWith(null, {
        replace: true,
      });
    });
  });

  it("starts a chat with the selected skill from the detail page", async () => {
    listSkills.mockResolvedValue(mockSkills);
    const onStartChatWithSkill = vi.fn();
    const user = userEvent.setup();

    render(<SkillsView onStartChatWithSkill={onStartChatWithSkill} />);
    await screen.findByText("code-review");

    await user.click(
      screen.getByRole("button", { name: "Open code-review details" }),
    );
    await user.click(screen.getByRole("button", { name: "Start chat" }));

    expect(onStartChatWithSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: "code-review" }),
      null,
    );
  });

  it("stays on the detail page after renaming a skill", async () => {
    const renamedSkill: SkillInfo = {
      ...mockSkills[1],
      id: "global:/path/renamed-review",
      name: "renamed-review",
      path: "/path/renamed-review",
      fileLocation: "/path/renamed-review/SKILL.md",
    };
    listSkills.mockResolvedValueOnce(mockSkills);
    updateSkill.mockResolvedValueOnce(renamedSkill);
    const user = userEvent.setup();

    render(<SkillsView />);
    await screen.findByText("code-review");

    await user.click(
      screen.getByRole("button", { name: "Open code-review details" }),
    );
    await user.click(screen.getByRole("button", { name: "Edit" }));

    const nameInput = screen.getByPlaceholderText("my-skill-name");
    await user.clear(nameInput);
    await user.type(nameInput, "renamed-review");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(updateSkill).toHaveBeenCalledWith(
        "/path/code-review",
        "renamed-review",
        "Reviews code",
        "Review the code...",
        expect.any(String),
      );
    });
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "renamed-review" }),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByPlaceholderText("my-skill-name"),
    ).not.toBeInTheDocument();
  });

  it("renders built-in skills alongside all skills in the default grid", async () => {
    listSkills.mockResolvedValue([...mockSkills, builtinSkill]);

    render(<SkillsView />);
    await screen.findByText("goose-doc-guide");

    // No section headers — everything renders flat.
    expect(screen.getByText("layout")).toBeInTheDocument();
    expect(screen.getByText("code-review")).toBeInTheDocument();
    expect(screen.getByText("test-writer")).toBeInTheDocument();
    expect(screen.getByText("goose-doc-guide")).toBeInTheDocument();
  });

  it("shows pin-to-home in skill card menus", async () => {
    listSkills.mockResolvedValue(mockSkills);
    const user = userEvent.setup();

    render(<SkillsView />);
    await screen.findByText("code-review");

    const codeReviewCard = screen.getByRole("button", {
      name: "Open code-review details",
    });
    const menuButton = within(codeReviewCard).getByRole("button", {
      name: "More",
    });
    await user.click(menuButton);

    expect(
      screen.getByRole("menuitem", { name: "Pin to home" }),
    ).toBeInTheDocument();
  });

  it("shows a delete confirmation from the detail panel", async () => {
    listSkills.mockResolvedValue(mockSkills);
    const user = userEvent.setup();

    render(<SkillsView />);
    await screen.findByText("code-review");

    await user.click(
      screen.getByRole("button", { name: "Open code-review details" }),
    );
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(
      screen.getByText('Delete "code-review" permanently?'),
    ).toBeInTheDocument();

    const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
    await user.click(deleteButtons[deleteButtons.length - 1]);

    await waitFor(() => {
      expect(deleteSkill).toHaveBeenCalledWith("/path/code-review");
    });
  });

  it("shows built-in details without filesystem actions and still starts chat", async () => {
    listSkills.mockResolvedValue([...mockSkills, builtinSkill]);
    const onStartChatWithSkill = vi.fn();
    const user = userEvent.setup();

    render(<SkillsView onStartChatWithSkill={onStartChatWithSkill} />);
    await screen.findByText("goose-doc-guide");

    await user.click(
      screen.getByRole("button", { name: "Open goose-doc-guide details" }),
    );

    expect(
      screen.getByText("Fetch Goose docs before answering."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Location")).not.toBeInTheDocument();
    expect(
      screen.queryByText("builtin://skills/goose-doc-guide"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show in folder" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "More" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Pin to home" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start chat" }));

    expect(onStartChatWithSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: "goose-doc-guide" }),
      null,
    );
    expect(updateSkill).not.toHaveBeenCalled();
    expect(deleteSkill).not.toHaveBeenCalled();
    expect(exportSkill).not.toHaveBeenCalled();
  });

  it("passes saved project working directories into listSkills", async () => {
    mockProjects = [
      {
        id: "project-goose",
        name: "Goose",
        workingDirs: ["/tmp/goose", "/tmp/goose-worktree"],
      },
    ];

    render(<SkillsView />);

    await waitFor(() => {
      expect(listSkills).toHaveBeenCalledWith([
        "/tmp/goose",
        "/tmp/goose-worktree",
      ]);
    });
  });

  it("opens the create dialog when the inline + tile is clicked", async () => {
    listSkills.mockResolvedValue(mockSkills);
    const user = userEvent.setup();

    render(<SkillsView />);
    await screen.findByText("code-review");

    const createControls = screen.getAllByRole("button", {
      name: "New skill",
    });
    const gridCreateControl = createControls.find((control) =>
      control.classList.contains("gallery-card-enter"),
    );
    if (!gridCreateControl) {
      throw new Error("Expected the grid create control to render");
    }
    await user.click(gridCreateControl);

    expect(
      screen.getByRole("heading", { name: "New skill" }),
    ).toBeInTheDocument();
  });
});
