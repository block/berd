import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { SidebarChatDragProvider } from "../SidebarChatDragContext";
import { SidebarChatRow } from "../SidebarChatRow";
import { SidebarProjectSection } from "../SidebarProjectSection";
import { SidebarRecentsSection } from "../SidebarRecentsSection";

const PROJECT: ProjectInfo = {
  id: "alpha",
  path: "/tmp/alpha",
  name: "Alpha",
  description: "",
  prompt: "",
  icon: "",
  color: "",
  workingDirs: [],
  useWorktrees: false,
  order: 0,
  archivedAt: null,
};

/** A stateful DataTransfer stub so setData on dragstart survives to drop. */
function createDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "all",
    setData: (type: string, value: string) => {
      store.set(type, value);
    },
    getData: (type: string) => store.get(type) ?? "",
    get types() {
      return Array.from(store.keys());
    },
  } as unknown as DataTransfer;
}

type MoveHandler = (sessionId: string, projectId: string | null) => void;

function renderSidebar(onMoveToProject: MoveHandler) {
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
        isExpanded
        toggleProject={vi.fn()}
        onMoveToProject={onMoveToProject}
      />
      <SidebarRecentsSection
        sessions={[
          { id: "r1", title: "Recent Chat", updatedAt: "2026-01-01T00:00:00Z" },
        ]}
        collapsed={false}
        labelTransition=""
        labelVisible
        isOpen
        onToggleOpen={vi.fn()}
        sectionHeaderTextClass=""
        onMoveToProject={onMoveToProject}
      />
    </SidebarChatDragProvider>,
  );
}

function dragRow(title: string) {
  const row = screen.getByText(title).closest("[draggable]");
  if (!row) throw new Error(`No draggable row for "${title}"`);
  const dataTransfer = createDataTransfer();
  fireEvent.dragStart(row, { dataTransfer });
  return dataTransfer;
}

describe("sidebar chat drag-to-move", () => {
  it("ignores a drop back onto the chat's own project (no-op)", () => {
    const onMoveToProject = vi.fn<MoveHandler>();
    renderSidebar(onMoveToProject);

    const dataTransfer = dragRow("Project Chat");
    const target = screen.getByText("Alpha");
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    expect(onMoveToProject).not.toHaveBeenCalled();
  });

  it("moves a Recents chat into a project when dropped on it", () => {
    const onMoveToProject = vi.fn<MoveHandler>();
    renderSidebar(onMoveToProject);

    const dataTransfer = dragRow("Recent Chat");
    const target = screen.getByText("Alpha");
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    expect(onMoveToProject).toHaveBeenCalledWith("r1", "alpha");
  });

  it("ignores a drop back into Recents for a chat already there (no-op)", () => {
    const onMoveToProject = vi.fn<MoveHandler>();
    renderSidebar(onMoveToProject);

    const dataTransfer = dragRow("Recent Chat");
    const target = screen.getByText("Recent Chat");
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    expect(onMoveToProject).not.toHaveBeenCalled();
  });

  it("moves a project chat out to Recents when dropped there", () => {
    const onMoveToProject = vi.fn<MoveHandler>();
    renderSidebar(onMoveToProject);

    const dataTransfer = dragRow("Project Chat");
    const target = screen.getByText("Recent Chat");
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    expect(onMoveToProject).toHaveBeenCalledWith("p1", null);
  });

  it("closes the row overflow menu when a drag starts", async () => {
    const user = userEvent.setup();
    render(
      <SidebarChatRow
        id="session-1"
        title="Draggable Chat"
        isActive={false}
        onMarkUnread={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for draggable chat/i }),
    );
    expect(
      screen.getByRole("menuitem", { name: /mark unread/i }),
    ).toBeInTheDocument();

    const row = screen.getByText("Draggable Chat").closest("[draggable]");
    if (!row) throw new Error("No draggable row");
    fireEvent.dragStart(row, { dataTransfer: createDataTransfer() });

    expect(
      screen.queryByRole("menuitem", { name: /mark unread/i }),
    ).not.toBeInTheDocument();
  });
});
