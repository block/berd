import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_PROJECT_FILTER_ID } from "@/features/sessions/lib/sessionListFilters";
import { i18n } from "@/shared/i18n";
import { renderWithProviders } from "@/test/render";
import {
  SessionListControls,
  type SessionListControlsProps,
} from "../SessionListControls";

vi.mock("@/features/projects/ui/ProjectIcon", () => ({
  ProjectIcon: ({
    icon,
    projectId,
  }: {
    icon?: string | null;
    projectId?: string;
  }) => (
    <span
      data-testid={`project-icon-${projectId}`}
      data-icon={icon ?? "default"}
    />
  ),
}));

const projects = [
  { id: "p1", name: "Alpha", color: "#ff0000", icon: "tabler:rocket" },
  { id: "p2", name: "Beta", color: "#00ff00" },
  { id: "p3", name: "Gamma" },
];

function renderControls(
  overrides: Partial<React.ComponentProps<typeof SessionListControls>> = {},
) {
  const props = {
    scope: "active" as const,
    onScopeChange: vi.fn(),
    projects,
    selectedProjectIds: new Set<string>(),
    onSelectedProjectIdsChange: vi.fn(),
    view: "list" as const,
    onViewChange: vi.fn(),
    ...overrides,
  };
  renderWithProviders(<SessionListControls {...props} />);
  return props;
}

/**
 * The checked state of the project rows only changes when the owning view feeds
 * a new selection back down, so aria-checked assertions need real state rather
 * than a spy.
 */
function renderStatefulControls(
  overrides: Partial<SessionListControlsProps> = {},
) {
  function Harness() {
    const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(
      new Set(),
    );
    return (
      <SessionListControls
        scope="active"
        onScopeChange={vi.fn()}
        projects={projects}
        view="list"
        onViewChange={vi.fn()}
        {...overrides}
        selectedProjectIds={selectedProjectIds}
        onSelectedProjectIdsChange={setSelectedProjectIds}
      />
    );
  }
  renderWithProviders(<Harness />);
}

async function openFilterMenuByKeyboard(
  user: ReturnType<typeof userEvent.setup>,
) {
  const trigger = screen.getByRole("button", { name: /projects|proyecto/i });
  trigger.focus();
  await user.keyboard("{Enter}");
  return screen.getByRole("menu");
}

describe("SessionListControls", () => {
  afterEach(async () => {
    // The Spanish cases mutate the shared i18n instance.
    if (i18n.language !== "en") {
      await act(async () => {
        await i18n.changeLanguage("en");
      });
    }
  });

  it("renders Active and Archived scope tabs", () => {
    renderControls();

    expect(screen.getByRole("tab", { name: "Active" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Archived" })).toBeInTheDocument();
  });

  it("marks the current scope tab as selected", () => {
    renderControls({ scope: "archived" });

    expect(screen.getByRole("tab", { name: "Archived" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("shows the archived count in the tab label when provided", () => {
    renderControls({ archivedCount: 4 });

    expect(
      screen.getByRole("tab", { name: "Archived (4)" }),
    ).toBeInTheDocument();
  });

  it("calls onScopeChange when switching tabs", async () => {
    const user = userEvent.setup();
    const { onScopeChange } = renderControls();

    await user.click(screen.getByRole("tab", { name: "Archived" }));

    expect(onScopeChange).toHaveBeenCalledWith("archived");
  });

  it("shows 'All projects' on the trigger when nothing is selected", () => {
    renderControls();

    expect(
      screen.getByRole("button", { name: "All projects" }),
    ).toBeInTheDocument();
  });

  it("shows the project name when exactly one project is selected", () => {
    renderControls({ selectedProjectIds: new Set(["p2"]) });

    expect(screen.getByRole("button", { name: "Beta" })).toBeInTheDocument();
  });

  it("shows a count when multiple projects are selected", () => {
    renderControls({ selectedProjectIds: new Set(["p1", "p2"]) });

    expect(
      screen.getByRole("button", { name: "2 projects" }),
    ).toBeInTheDocument();
  });

  it("shows 'No project' when only the sentinel is selected", () => {
    renderControls({
      selectedProjectIds: new Set([NO_PROJECT_FILTER_ID]),
      showNoProject: true,
    });

    expect(
      screen.getByRole("button", { name: "No project" }),
    ).toBeInTheDocument();
  });

  it("renders a reset command plus one checkbox row per filter, with no separator", async () => {
    const user = userEvent.setup();
    renderControls({ showNoProject: true });

    await user.click(screen.getByRole("button", { name: "All projects" }));

    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(1);
    expect(within(menu).getAllByRole("menuitemcheckbox")).toHaveLength(4);
    expect(within(menu).queryByRole("separator")).not.toBeInTheDocument();
  });

  it("renders a ProjectIcon for each project row", async () => {
    const user = userEvent.setup();
    renderControls();

    await user.click(screen.getByRole("button", { name: "All projects" }));

    const alphaIcon = screen.getByTestId("project-icon-p1");
    expect(alphaIcon).toHaveAttribute("data-icon", "tabler:rocket");
    expect(screen.getByTestId("project-icon-p2")).toHaveAttribute(
      "data-icon",
      "default",
    );
    expect(screen.getByTestId("project-icon-p3")).toBeInTheDocument();
  });

  it("shows the check indicator only on selected rows", async () => {
    const user = userEvent.setup();
    renderControls({ selectedProjectIds: new Set(["p1"]) });

    await user.click(screen.getByRole("button", { name: "Alpha" }));

    const alphaRow = screen.getByRole("menuitemcheckbox", { name: "Alpha" });
    const betaRow = screen.getByRole("menuitemcheckbox", { name: "Beta" });
    const allRow = screen.getByRole("menuitem", { name: "All projects" });

    expect(alphaRow.querySelector("svg.lucide-check")).toBeInTheDocument();
    expect(betaRow.querySelector("svg.lucide-check")).not.toBeInTheDocument();
    expect(allRow.querySelector("svg.lucide-check")).toHaveClass("opacity-0");
  });

  it("shows the check on 'All projects' when nothing is selected", async () => {
    const user = userEvent.setup();
    renderControls();

    await user.click(screen.getByRole("button", { name: "All projects" }));

    const allRow = screen.getAllByRole("menuitem", { name: "All projects" })[0];
    expect(allRow.querySelector("svg.lucide-check")).not.toHaveClass(
      "opacity-0",
    );
  });

  it("adds a project to the selection when its item is toggled", async () => {
    const user = userEvent.setup();
    const { onSelectedProjectIdsChange } = renderControls({
      selectedProjectIds: new Set(["p1"]),
    });

    await user.click(screen.getByRole("button", { name: "Alpha" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Beta" }));

    expect(onSelectedProjectIdsChange).toHaveBeenCalledWith(
      new Set(["p1", "p2"]),
    );
  });

  it("removes a project from the selection when it is already selected", async () => {
    const user = userEvent.setup();
    const { onSelectedProjectIdsChange } = renderControls({
      selectedProjectIds: new Set(["p1", "p2"]),
    });

    await user.click(screen.getByRole("button", { name: "2 projects" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Alpha" }));

    expect(onSelectedProjectIdsChange).toHaveBeenCalledWith(new Set(["p2"]));
  });

  it("keeps the menu open after toggling a project", async () => {
    const user = userEvent.setup();
    renderControls();

    await user.click(screen.getByRole("button", { name: "All projects" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Beta" }));

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("resets the selection via the 'All projects' item", async () => {
    const user = userEvent.setup();
    const { onSelectedProjectIdsChange } = renderControls({
      selectedProjectIds: new Set(["p1", "p2"]),
    });

    await user.click(screen.getByRole("button", { name: "2 projects" }));
    await user.click(screen.getByRole("menuitem", { name: "All projects" }));

    expect(onSelectedProjectIdsChange).toHaveBeenCalledWith(new Set());
  });

  it("only shows the 'No project' item when showNoProject is set", async () => {
    const user = userEvent.setup();
    renderControls();

    await user.click(screen.getByRole("button", { name: "All projects" }));

    expect(
      screen.queryByRole("menuitemcheckbox", { name: "No project" }),
    ).not.toBeInTheDocument();
  });

  it("toggles the no-project sentinel", async () => {
    const user = userEvent.setup();
    const { onSelectedProjectIdsChange } = renderControls({
      showNoProject: true,
    });

    await user.click(screen.getByRole("button", { name: "All projects" }));
    await user.click(
      screen.getByRole("menuitemcheckbox", { name: "No project" }),
    );

    expect(onSelectedProjectIdsChange).toHaveBeenCalledWith(
      new Set([NO_PROJECT_FILTER_ID]),
    );
  });

  it("renders list and grid view toggles with the selected state", () => {
    renderControls({ view: "grid" });

    // ToggleGroup type="single" exposes items as a radio group.
    const listToggle = screen.getByRole("radio", { name: "List view" });
    const gridToggle = screen.getByRole("radio", { name: "Grid view" });

    expect(listToggle).toHaveAttribute("aria-checked", "false");
    expect(listToggle).toHaveAttribute("data-state", "off");
    expect(gridToggle).toHaveAttribute("aria-checked", "true");
    expect(gridToggle).toHaveAttribute("data-state", "on");
  });

  it("calls onViewChange when a view toggle is clicked", async () => {
    const user = userEvent.setup();
    const { onViewChange } = renderControls({ view: "list" });

    await user.click(screen.getByRole("radio", { name: "Grid view" }));

    expect(onViewChange).toHaveBeenCalledWith("grid");
  });

  it("exposes each project filter to assistive tech as a checkbox row", async () => {
    const user = userEvent.setup();
    renderControls({
      showNoProject: true,
      selectedProjectIds: new Set(["p2", NO_PROJECT_FILTER_ID]),
    });

    await user.click(screen.getByRole("button", { name: "2 projects" }));

    expect(
      screen.getByRole("menuitemcheckbox", { name: "Alpha" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Beta" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Gamma" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByRole("menuitemcheckbox", { name: "No project" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("flips aria-checked on a project row when toggled by keyboard", async () => {
    const user = userEvent.setup();
    renderStatefulControls();

    await openFilterMenuByKeyboard(user);

    const alphaRow = screen.getByRole("menuitemcheckbox", { name: "Alpha" });
    expect(alphaRow).toHaveAttribute("aria-checked", "false");

    // Walk down from the reset row to Alpha, then activate it.
    while (document.activeElement !== alphaRow) {
      await user.keyboard("{ArrowDown}");
    }
    await user.keyboard("{Enter}");

    expect(
      screen.getByRole("menuitemcheckbox", { name: "Alpha" }),
    ).toHaveAttribute("aria-checked", "true");
    // Multi-select depends on the menu surviving a toggle.
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("flips aria-checked on the 'No project' row when toggled", async () => {
    const user = userEvent.setup();
    renderStatefulControls({ showNoProject: true });

    await user.click(screen.getByRole("button", { name: "All projects" }));

    expect(
      screen.getByRole("menuitemcheckbox", { name: "No project" }),
    ).toHaveAttribute("aria-checked", "false");

    await user.click(
      screen.getByRole("menuitemcheckbox", { name: "No project" }),
    );

    expect(
      screen.getByRole("menuitemcheckbox", { name: "No project" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("keeps 'All projects' a reset command rather than a checkbox", async () => {
    const user = userEvent.setup();
    renderControls();

    await user.click(screen.getByRole("button", { name: "All projects" }));

    const allRow = screen.getByRole("menuitem", { name: "All projects" });
    expect(allRow).not.toHaveAttribute("aria-checked");
  });

  // jsdom has no layout, so these assert the structural guarantees that keep
  // the row from overflowing at the 608px minimum window width rather than
  // measuring pixels.
  describe("narrow-width layout structure", () => {
    const longProject = {
      id: "p-long",
      name: "Extremely Long Project Name That Would Otherwise Push The View Toggle Off Screen",
    };

    it("wraps the controls row and lets only the filter label shrink", () => {
      renderControls({ projects: [longProject], archivedCount: 128 });

      const tabList = screen.getByRole("tablist");
      const row = tabList.parentElement?.parentElement;
      expect(row).toHaveClass("flex-wrap");

      const trigger = screen.getByRole("button", { name: "All projects" });
      expect(trigger).toHaveClass("min-w-0");
      expect(trigger.parentElement).toHaveClass("min-w-0");
      expect(trigger.querySelector("span.truncate")?.textContent).toBe(
        "All projects",
      );
    });

    it("keeps the segmented view toggle from shrinking", () => {
      renderControls({ projects: [longProject], archivedCount: 128 });

      const listToggle = screen.getByRole("radio", { name: "List view" });
      expect(listToggle.parentElement).toHaveClass("shrink-0");
    });

    it("keeps every control present and operable with a long project name and a multi-digit archived count", async () => {
      const user = userEvent.setup();
      const { onSelectedProjectIdsChange, onViewChange, onScopeChange } =
        renderControls({ projects: [longProject], archivedCount: 128 });

      expect(
        screen.getByRole("tab", { name: "Archived (128)" }),
      ).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "All projects" }));
      await user.click(
        screen.getByRole("menuitemcheckbox", { name: longProject.name }),
      );
      expect(onSelectedProjectIdsChange).toHaveBeenCalledWith(
        new Set([longProject.id]),
      );

      await user.keyboard("{Escape}");
      await user.click(screen.getByRole("radio", { name: "Grid view" }));
      expect(onViewChange).toHaveBeenCalledWith("grid");

      await user.click(screen.getByRole("tab", { name: "Archived (128)" }));
      expect(onScopeChange).toHaveBeenCalledWith("archived");
    });

    it("keeps the same structure and operability with Spanish labels", async () => {
      await act(async () => {
        await i18n.changeLanguage("es");
      });
      const user = userEvent.setup();
      const { onViewChange } = renderControls({
        projects: [longProject],
        archivedCount: 128,
      });

      const tabList = screen.getByRole("tablist");
      expect(tabList.parentElement?.parentElement).toHaveClass("flex-wrap");
      expect(
        screen.getByRole("tab", { name: "Archivadas (128)" }),
      ).toBeInTheDocument();

      const trigger = screen.getByRole("button", {
        name: "Todos los proyectos",
      });
      expect(trigger).toHaveClass("min-w-0");
      expect(trigger.querySelector("span.truncate")).toBeInTheDocument();

      const listToggle = screen.getByRole("radio", { name: "Vista de lista" });
      expect(listToggle.parentElement).toHaveClass("shrink-0");

      await user.click(
        screen.getByRole("radio", { name: "Vista de cuadrícula" }),
      );
      expect(onViewChange).toHaveBeenCalledWith("grid");
    });
  });
});
