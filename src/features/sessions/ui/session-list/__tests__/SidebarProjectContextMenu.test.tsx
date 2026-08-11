import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { SidebarChatDragProvider } from "../SidebarChatDragContext";
import { SidebarProjectSection } from "../SidebarProjectSection";

const PROJECT: ProjectInfo = {
  id: "alpha",
  path: "/tmp/alpha",
  name: "Alpha",
  description: "",
  prompt: "",
  icon: "",
  color: "",
  projectWorkspaces: [],
  workingDirs: [],
  useWorktrees: false,
  order: 0,
  archivedAt: null,
};

function renderSection(
  overrides: Partial<{
    onEditProject: (projectId: string) => void;
    onArchiveProject: (projectId: string) => void;
  }> = {},
) {
  return render(
    <SidebarChatDragProvider>
      <SidebarProjectSection
        project={PROJECT}
        projectChats={[
          {
            id: "p1",
            title: "Project Chat",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ]}
        isExpanded={false}
        toggleProject={vi.fn()}
        showChatIcons
        showTimestamps
        {...overrides}
      />
    </SidebarChatDragProvider>,
  );
}

function getProjectRow(container: HTMLElement) {
  const row = container.querySelector("[data-sidebar-project-row]");
  if (!row) {
    throw new Error("Sidebar project row was not rendered");
  }
  return row;
}

describe("project row context menu", () => {
  it("opens a cursor-anchored context menu on right-click", async () => {
    const { container } = renderSection();

    fireEvent.contextMenu(getProjectRow(container), {
      clientX: 128,
      clientY: 256,
    });

    expect(
      await screen.findByRole("menuitem", { name: /edit/i }),
    ).toBeInTheDocument();
    const content = document.querySelector(
      '[data-slot="context-menu-content"]',
    );
    expect(content).toHaveAttribute("data-variant", "raised");
    expect(
      document.querySelector('[data-slot="dropdown-menu-content"]'),
    ).not.toBeInTheDocument();
  });

  it("offers the same actions as the overflow menu", async () => {
    const user = userEvent.setup();
    const { unmount } = renderSection();

    await user.click(
      screen.getByRole("button", { name: /options for alpha/i }),
    );
    const overflowActions = screen
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(overflowActions.length).toBeGreaterThan(0);
    unmount();

    const second = renderSection();
    fireEvent.contextMenu(getProjectRow(second.container), {
      clientX: 10,
      clientY: 10,
    });
    await screen.findByRole("menuitem", { name: /edit/i });
    const contextActions = screen
      .getAllByRole("menuitem")
      .map((item) => item.textContent);

    // Right-click is a second way in, not a different menu: same actions,
    // same order.
    expect(contextActions).toEqual(overflowActions);
  });

  it("invokes project actions from the context menu", async () => {
    const onEditProject = vi.fn();
    const onArchiveProject = vi.fn();
    const { container } = renderSection({ onEditProject, onArchiveProject });

    fireEvent.contextMenu(getProjectRow(container), {
      clientX: 12,
      clientY: 24,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: /edit/i }));

    expect(onEditProject).toHaveBeenCalledWith("alpha");
    expect(onArchiveProject).not.toHaveBeenCalled();
  });

  it("does not expand or navigate the project when right-clicked", () => {
    const toggleProject = vi.fn();
    const onOpenProject = vi.fn();
    const { container } = render(
      <SidebarChatDragProvider>
        <SidebarProjectSection
          project={PROJECT}
          projectChats={[]}
          isExpanded={false}
          toggleProject={toggleProject}
          onOpenProject={onOpenProject}
          showChatIcons
          showTimestamps
        />
      </SidebarChatDragProvider>,
    );

    fireEvent.contextMenu(getProjectRow(container), {
      clientX: 12,
      clientY: 24,
    });

    expect(toggleProject).not.toHaveBeenCalled();
    expect(onOpenProject).not.toHaveBeenCalled();
  });
});
