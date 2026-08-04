import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { SidebarProjectList } from "../SidebarProjectList";

function project(overrides: Partial<ProjectInfo>): ProjectInfo {
  return {
    id: "project",
    path: "/tmp/project",
    name: "Project",
    description: "",
    prompt: "",
    icon: "",
    color: "",
    workingDirs: [],
    projectWorkspaces: [],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
    ...overrides,
  };
}

function renderProjectList(
  onReorderProject: (
    fromId: string,
    toId: string,
    placement?: "before" | "after",
  ) => void,
) {
  return render(
    <SidebarProjectList
      projects={[
        project({ id: "alpha", name: "Alpha", order: 0 }),
        project({ id: "bravo", name: "Bravo", order: 1 }),
        project({ id: "charlie", name: "Charlie", order: 2 }),
      ]}
      projectSessionsByProject={{}}
      expandedProjects={{}}
      toggleProject={vi.fn()}
      collapsed={false}
      showChatIcons
      showTimestamps
      onReorderProject={onReorderProject}
    />,
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

function projectRow(name: string) {
  const row = screen
    .getByText(name)
    .closest("[data-sidebar-project-draggable]");
  if (!row) throw new Error(`No draggable project for ${name}`);
  return row;
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

function pointerDragProjectTo({
  from,
  clientY,
}: {
  from: string;
  clientY: number;
}) {
  const row = projectRow(from);
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

describe("sidebar project pointer reorder", () => {
  it("keeps collapsed project icons accessibly named", () => {
    render(
      <SidebarProjectList
        projects={[project({ id: "alpha", name: "Alpha", order: 0 })]}
        projectSessionsByProject={{}}
        expandedProjects={{}}
        toggleProject={vi.fn()}
        collapsed
        showChatIcons
        showTimestamps
      />,
    );

    expect(screen.getByRole("button", { name: "Alpha" })).toBeInTheDocument();
  });

  it("moves a project before an earlier target", () => {
    const onReorderProject = vi.fn();
    renderProjectList(onReorderProject);
    mockRect(projectRow("Alpha"), { top: 0, bottom: 40 });
    mockRect(projectRow("Bravo"), { top: 40, bottom: 80 });
    mockRect(projectRow("Charlie"), { top: 80, bottom: 120 });

    pointerDragProjectTo({ from: "Charlie", clientY: 20 });

    expect(onReorderProject).toHaveBeenCalledWith("charlie", "alpha", "before");
  });

  it("moves a project after a later target", () => {
    const onReorderProject = vi.fn();
    renderProjectList(onReorderProject);
    mockRect(projectRow("Alpha"), { top: 0, bottom: 40 });
    mockRect(projectRow("Bravo"), { top: 40, bottom: 80 });
    mockRect(projectRow("Charlie"), { top: 80, bottom: 120 });

    pointerDragProjectTo({ from: "Alpha", clientY: 110 });

    expect(onReorderProject).toHaveBeenCalledWith("alpha", "charlie", "after");
  });

  it("does not start a reorder from project row controls", () => {
    const onReorderProject = vi.fn();
    renderProjectList(onReorderProject);
    mockRect(projectRow("Alpha"), { top: 0, bottom: 40 });
    mockRect(projectRow("Bravo"), { top: 40, bottom: 80 });

    const control = screen.getAllByRole("button", {
      name: /new chat in project/i,
    })[0];
    dispatchPointerEvent(control, "pointerdown", {
      pointerId: 1,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    dispatchPointerEvent(window, "pointermove", {
      pointerId: 1,
      clientX: 20,
      clientY: 70,
    });
    dispatchPointerEvent(window, "pointerup", {
      pointerId: 1,
      clientX: 20,
      clientY: 70,
    });

    expect(onReorderProject).not.toHaveBeenCalled();
  });
});
