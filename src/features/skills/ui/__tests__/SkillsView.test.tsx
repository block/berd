import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  TopBarActionsProvider,
  useTopBarActions,
} from "@/app/contexts/TopBarActionsContext";
import type { SkillInfo } from "../../api/skills";
import { SkillsView } from "../SkillsView";

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
}));

vi.mock("@/features/projects/stores/projectStore", () => ({
  useProjectStore: (
    selector: (state: { projects: MockProject[] }) => unknown,
  ) => selector({ projects: mockProjects }),
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
  vi.clearAllMocks();
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
      screen.getByRole("button", { name: "Back to skills" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Write tests...")).toBeInTheDocument();
    expect(
      screen.getByText("/tmp/alpha/.goose/skills/test-writer/SKILL.md"),
    ).toBeInTheDocument();
  });

  it("filters skills with page-local search", async () => {
    listSkills.mockResolvedValue(mockSkills);
    const user = userEvent.setup();

    renderSkillsViewWithTopBarActions();
    await screen.findByText("code-review");

    await user.type(
      screen.getByRole("searchbox", { name: "Search skills" }),
      "test",
    );

    expect(screen.getByText("test-writer")).toBeInTheDocument();
    expect(screen.queryByText("layout")).not.toBeInTheDocument();
    expect(screen.queryByText("code-review")).not.toBeInTheDocument();
  });

  it("filters skills to global sources", async () => {
    listSkills.mockResolvedValue([...mockSkills, builtinSkill]);
    const user = userEvent.setup();

    renderSkillsViewWithTopBarActions();
    await screen.findByText("test-writer");

    await user.click(
      screen.getByRole("button", { name: "Filter skills by source" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Global" }));

    expect(screen.getByText("layout")).toBeInTheDocument();
    expect(screen.getByText("goose-doc-guide")).toBeInTheDocument();
    expect(screen.queryByText("test-writer")).not.toBeInTheDocument();
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
    expect(
      screen.queryByRole("menuitemradio", { name: "alpha" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "alpha" }));

    expect(screen.getByText("test-writer")).toBeInTheDocument();
    expect(screen.queryByText("layout")).not.toBeInTheDocument();
    expect(screen.queryByText("code-review")).not.toBeInTheDocument();
  });

  it("preselects the current project when creating from a project filter", async () => {
    listSkills.mockResolvedValue(mockSkills);
    const user = userEvent.setup();

    renderSkillsViewWithTopBarActions();
    await screen.findByText("code-review");

    await user.click(
      screen.getByRole("button", { name: "Filter skills by source" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "alpha" }));
    await user.click(screen.getAllByRole("button", { name: "New skill" })[0]);
    await user.click(screen.getByRole("menuitem", { name: "Create manually" }));

    expect(
      screen.getByText("Stored in the project folder"),
    ).toBeInTheDocument();
  });

  it("starts skill builder chat from the top bar create menu", async () => {
    listSkills.mockResolvedValue(mockSkills);
    const onStartChatWithSkill = vi.fn();
    const user = userEvent.setup();

    renderSkillsViewWithTopBarActions({ onStartChatWithSkill });
    await screen.findByText("code-review");

    await user.click(screen.getAllByRole("button", { name: "New skill" })[0]);
    await user.click(
      screen.getByRole("menuitem", { name: "Create with chat" }),
    );

    expect(onStartChatWithSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "builtin:skill-builder",
        name: "skill-builder",
      }),
      null,
    );
  });

  it("starts project-scoped skill builder chat from a project filter", async () => {
    listSkills.mockResolvedValue(mockSkills);
    const onStartChatWithSkill = vi.fn();
    const user = userEvent.setup();

    renderSkillsViewWithTopBarActions({ onStartChatWithSkill });
    await screen.findByText("code-review");

    await user.click(
      screen.getByRole("button", { name: "Filter skills by source" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "alpha" }));
    await user.click(screen.getAllByRole("button", { name: "New skill" })[0]);
    await user.click(
      screen.getByRole("menuitem", { name: "Create with chat" }),
    );

    expect(onStartChatWithSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: "skill-builder" }),
      "project-alpha",
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
      screen.getByRole("button", { name: "Back to skills" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to skills" }));

    expect(onActiveSkillIdChange).toHaveBeenCalledWith(null, undefined);
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

  it("returns to the list after viewing a skill detail", async () => {
    listSkills.mockResolvedValue(mockSkills);
    const user = userEvent.setup();

    render(<SkillsView />);
    await screen.findByText("code-review");

    await user.click(
      screen.getByRole("button", { name: "Open code-review details" }),
    );
    await user.click(screen.getByRole("button", { name: "Back to skills" }));

    expect(screen.getByText("code-review")).toBeInTheDocument();
    expect(screen.getByText("test-writer")).toBeInTheDocument();
  });

  it("stays on the detail page after renaming a skill", async () => {
    const renamedSkill: SkillInfo = {
      ...mockSkills[1],
      id: "global:/path/renamed-review",
      name: "renamed-review",
      path: "/path/renamed-review",
      fileLocation: "/path/renamed-review/SKILL.md",
    };
    listSkills
      .mockResolvedValueOnce(mockSkills)
      .mockResolvedValueOnce([mockSkills[0], renamedSkill, mockSkills[2]]);
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
        screen.getByRole("button", { name: "Back to skills" }),
      ).toBeInTheDocument();
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

  it("shows a delete confirmation from the detail panel", async () => {
    listSkills.mockResolvedValue(mockSkills);
    const user = userEvent.setup();

    render(<SkillsView />);
    await screen.findByText("code-review");

    await user.click(
      screen.getByRole("button", { name: "Open code-review details" }),
    );
    screen.getByRole("button", { name: "More" }).focus();
    await user.keyboard("{Enter}");
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

    // The grid's inline create tile shares the "New skill" aria-label with
    // the header button. Click the first matching control (the grid tile).
    const createControls = screen.getAllByRole("button", {
      name: "New skill",
    });
    await user.click(createControls[0]);

    expect(
      screen.getByRole("heading", { name: "New skill" }),
    ).toBeInTheDocument();
  });
});
