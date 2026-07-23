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
  projectWorkspaces: [],
  workingDirs: [],
  useWorktrees: false,
  order: 0,
  archivedAt: null,
};

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
        showChatIcons
        showTimestamps
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
        showChatIcons
        onShowChatIconsChange={vi.fn()}
        showTimestamps
        onShowTimestampsChange={vi.fn()}
        onMoveToProject={onMoveToProject}
      />
    </SidebarChatDragProvider>,
  );
}

function mockRect(element: Element, rect: Pick<DOMRect, "top" | "bottom">) {
  const height = rect.bottom - rect.top;
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: rect.top,
    top: rect.top,
    bottom: rect.bottom,
    left: 0,
    right: 300,
    width: 300,
    height,
    toJSON: () => ({}),
  } as DOMRect);
}

function draggableRow(title: string) {
  const row = screen.getByText(title).closest("[data-sidebar-chat-draggable]");
  if (!row) throw new Error(`No draggable row for "${title}"`);
  return row;
}

function dropTarget(kind: "project" | "recents") {
  const target = document.querySelector(
    `[data-sidebar-session-drop-target="${kind}"]`,
  );
  if (!target) throw new Error(`No ${kind} drop target`);
  return target;
}

function dispatchPointerEvent(
  target: Element | Window | Document,
  type: string,
  props: {
    pointerId?: number;
    button?: number;
    clientX: number;
    clientY: number;
  },
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: props.button ?? 0,
    clientX: props.clientX,
    clientY: props.clientY,
  });
  Object.defineProperty(event, "pointerId", {
    configurable: true,
    value: props.pointerId ?? 1,
  });
  fireEvent(target, event);
}

function pointerDragRowTo(title: string, clientY: number) {
  const row = draggableRow(title);
  dispatchPointerEvent(row, "pointerdown", {
    pointerId: 1,
    button: 0,
    clientX: 10,
    clientY: 10,
  });
  dispatchPointerEvent(window, "pointermove", {
    pointerId: 1,
    clientX: 20,
    clientY,
  });
  dispatchPointerEvent(window, "pointerup", {
    pointerId: 1,
    clientX: 20,
    clientY,
  });
}

describe("sidebar chat drag-to-move", () => {
  it("ignores a drop back onto the chat's own project (no-op)", () => {
    const onMoveToProject = vi.fn<MoveHandler>();
    renderSidebar(onMoveToProject);
    mockRect(dropTarget("project"), { top: 0, bottom: 80 });

    pointerDragRowTo("Project Chat", 40);

    expect(onMoveToProject).not.toHaveBeenCalled();
  });

  it("moves a Recents chat into a project when dropped on it", () => {
    const onMoveToProject = vi.fn<MoveHandler>();
    renderSidebar(onMoveToProject);
    mockRect(dropTarget("project"), { top: 0, bottom: 80 });

    pointerDragRowTo("Recent Chat", 40);

    expect(onMoveToProject).toHaveBeenCalledWith("r1", "alpha");
  });

  it("does not drop chats onto projects while project drop targets are disabled", () => {
    const onMoveToProject = vi.fn<MoveHandler>();
    render(
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
          showChatIcons
          showTimestamps
          onMoveToProject={onMoveToProject}
          dropTargetEnabled={false}
        />
        <SidebarRecentsSection
          sessions={[
            {
              id: "r1",
              title: "Recent Chat",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ]}
          collapsed={false}
          labelTransition=""
          labelVisible
          isOpen
          onToggleOpen={vi.fn()}
          sectionHeaderTextClass=""
          showChatIcons
          onShowChatIconsChange={vi.fn()}
          showTimestamps
          onShowTimestampsChange={vi.fn()}
          onMoveToProject={onMoveToProject}
        />
      </SidebarChatDragProvider>,
    );

    mockRect(dropTarget("project"), { top: 0, bottom: 80 });
    pointerDragRowTo("Recent Chat", 40);

    expect(onMoveToProject).not.toHaveBeenCalled();
  });

  it("ignores a drop back into Recents for a chat already there (no-op)", () => {
    const onMoveToProject = vi.fn<MoveHandler>();
    renderSidebar(onMoveToProject);
    mockRect(dropTarget("recents"), { top: 100, bottom: 180 });

    pointerDragRowTo("Recent Chat", 140);

    expect(onMoveToProject).not.toHaveBeenCalled();
  });

  it("moves a project chat out to Recents when dropped there", () => {
    const onMoveToProject = vi.fn<MoveHandler>();
    renderSidebar(onMoveToProject);
    mockRect(dropTarget("recents"), { top: 100, bottom: 180 });

    pointerDragRowTo("Project Chat", 140);

    expect(onMoveToProject).toHaveBeenCalledWith("p1", null);
  });

  it("suppresses hover hit-testing on chat rows while dragging", () => {
    renderSidebar(vi.fn<MoveHandler>());

    const sourceRow = draggableRow("Project Chat");
    const underlyingRow = draggableRow("Recent Chat");
    dispatchPointerEvent(sourceRow, "pointerdown", {
      pointerId: 1,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    dispatchPointerEvent(window, "pointermove", {
      pointerId: 1,
      clientX: 20,
      clientY: 20,
    });

    expect(sourceRow).toHaveClass("pointer-events-none", "opacity-40");
    expect(underlyingRow).toHaveClass("pointer-events-none");
    const preview = document.querySelector("[data-sidebar-chat-drag-preview]");
    expect(preview).toHaveTextContent("Project Chat");
    expect(preview).toHaveStyle({ left: "32px", top: "32px" });

    dispatchPointerEvent(window, "pointermove", {
      pointerId: 1,
      clientX: 40,
      clientY: 50,
    });
    expect(preview).toHaveStyle({ left: "52px", top: "62px" });

    dispatchPointerEvent(window, "pointerup", {
      pointerId: 1,
      clientX: 20,
      clientY: 20,
    });

    expect(sourceRow).not.toHaveClass("pointer-events-none", "opacity-40");
    expect(underlyingRow).not.toHaveClass("pointer-events-none");
    expect(
      document.querySelector("[data-sidebar-chat-drag-preview]"),
    ).not.toBeInTheDocument();
  });

  it("restores chat row hit-testing when the pointer drag is cancelled", () => {
    renderSidebar(vi.fn<MoveHandler>());

    const sourceRow = draggableRow("Project Chat");
    const underlyingRow = draggableRow("Recent Chat");
    dispatchPointerEvent(sourceRow, "pointerdown", {
      pointerId: 1,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    dispatchPointerEvent(window, "pointermove", {
      pointerId: 1,
      clientX: 20,
      clientY: 20,
    });
    expect(sourceRow).toHaveClass("pointer-events-none", "opacity-40");
    expect(underlyingRow).toHaveClass("pointer-events-none");

    dispatchPointerEvent(window, "pointercancel", {
      pointerId: 1,
      clientX: 20,
      clientY: 20,
    });

    expect(sourceRow).not.toHaveClass("pointer-events-none", "opacity-40");
    expect(underlyingRow).not.toHaveClass("pointer-events-none");
    expect(
      document.querySelector("[data-sidebar-chat-drag-preview]"),
    ).not.toBeInTheDocument();
  });

  it("closes the row overflow menu when a drag starts", async () => {
    const user = userEvent.setup();
    render(
      <SidebarChatDragProvider>
        <SidebarChatRow
          id="session-1"
          title="Draggable Chat"
          isActive={false}
          onMarkUnread={vi.fn()}
        />
      </SidebarChatDragProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: /options for draggable chat/i }),
    );
    expect(
      screen.getByRole("menuitem", { name: /mark unread/i }),
    ).toBeInTheDocument();

    const row = draggableRow("Draggable Chat");
    dispatchPointerEvent(row, "pointerdown", {
      pointerId: 1,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    dispatchPointerEvent(window, "pointermove", {
      pointerId: 1,
      clientX: 20,
      clientY: 20,
    });

    expect(
      screen.queryByRole("menuitem", { name: /mark unread/i }),
    ).not.toBeInTheDocument();

    dispatchPointerEvent(window, "pointerup", {
      pointerId: 1,
      clientX: 20,
      clientY: 20,
    });
  });
});
