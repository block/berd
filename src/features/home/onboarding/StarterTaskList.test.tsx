import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { StarterTaskList, type StarterTaskListLabels } from "./StarterTaskList";

const labels: StarterTaskListLabels = {
  title: "Starter task list",
  backHome: "Back to Home",
  backToList: "Back to starter tasks",
  markDone: "Mark as done",
  dismiss: "Dismiss starter tasks",
  closeTaskDetails: "Close task details",
  tasks: {
    "connect-provider": "Connect an AI provider",
    "start-chat": "Start a chat",
    "create-project": "Create a project",
    "add-widget": "Add a widget to Home",
  },
  taskDetails: {
    "connect-provider": "Connect a provider to choose a model.",
    "start-chat": "Start a regular chat.",
    "create-project": "Keep related work together.",
    "add-widget": "Personalize Home with useful information.",
  },
  openTask: (label) => `Open task: ${label}`,
  completedTask: (label) => `Completed task: ${label}`,
  checkTask: (label) => `Check ${label}`,
  uncheckTask: (label) => `Uncheck ${label}`,
};
const incomplete = {
  "connect-provider": false,
  "start-chat": false,
  "create-project": false,
  "add-widget": false,
};

function renderList(
  overrides: Partial<ComponentProps<typeof StarterTaskList>> = {},
) {
  const props: ComponentProps<typeof StarterTaskList> = {
    completionState: incomplete,
    mode: "canvas",
    labels,
    onTaskSelect: vi.fn(),
    onTaskToggle: vi.fn(),
    onBackHome: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
  return { ...render(<StarterTaskList {...props} />), props };
}

describe("StarterTaskList", () => {
  it("shows details, navigates, marks the task complete, and returns Home", () => {
    const onTaskSelect = vi.fn();
    const onTaskToggle = vi.fn();
    const onBackHome = vi.fn();
    renderList({ onTaskSelect, onTaskToggle, onBackHome });
    expect(screen.getAllByRole("listitem")).toHaveLength(4);

    fireEvent.click(
      screen.getByRole("button", { name: "Open task: Start a chat" }),
    );

    expect(onTaskSelect).toHaveBeenCalledWith("start-chat");
    expect(
      screen.getByRole("heading", { name: "Start a chat" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Start a regular chat.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mark as done" }));
    expect(onTaskToggle).toHaveBeenCalledWith("start-chat");
    expect(onBackHome).toHaveBeenCalledOnce();
  });

  it("returns Home without unchecking when the task is already done", () => {
    const onTaskToggle = vi.fn();
    const onBackHome = vi.fn();
    renderList({
      completionState: { ...incomplete, "connect-provider": true },
      onTaskToggle,
      onBackHome,
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Completed task: Connect an AI provider",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark as done" }));

    expect(onTaskToggle).not.toHaveBeenCalled();
    expect(onBackHome).toHaveBeenCalledOnce();
  });

  it("slides the overlay in with eased motion", () => {
    renderList({ mode: "overlay", selectedTaskId: "create-project" });

    expect(
      screen.getByRole("region", { name: "Create a project" }),
    ).toHaveClass(
      "motion-safe:slide-in-from-right-8",
      "motion-safe:duration-500",
      "motion-safe:ease-[cubic-bezier(0.19,1,0.22,1)]",
      "motion-reduce:animate-none",
    );
  });

  it("lets the project task sticky be dragged while the panel is open", () => {
    renderList({ mode: "overlay", selectedTaskId: "create-project" });
    const region = screen.getByRole("region", { name: "Create a project" });
    const header = within(region).getByRole("button", {
      name: "Back to starter tasks",
    }).parentElement as HTMLElement;
    vi.spyOn(region, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 100,
      right: 356,
      bottom: 296,
      width: 256,
      height: 196,
      x: 100,
      y: 100,
      toJSON: () => ({}),
    });
    header.setPointerCapture = vi.fn();
    const downEvent = new Event("pointerdown", { bubbles: true });
    Object.defineProperties(downEvent, {
      button: { value: 0 },
      clientX: { value: 120 },
      clientY: { value: 120 },
      pointerId: { value: 1 },
    });
    fireEvent(header, downEvent);
    const moveEvent = new Event("pointermove", { bubbles: true });
    Object.defineProperties(moveEvent, {
      clientX: { value: 220 },
      clientY: { value: 200 },
    });
    fireEvent(window, moveEvent);
    fireEvent.pointerUp(window, { pointerId: 1 });

    expect(region).toHaveStyle({ left: "200px", top: "180px" });
  });

  it("slides out with the project panel", () => {
    renderList({
      mode: "overlay",
      selectedTaskId: "create-project",
      exiting: true,
    });

    expect(
      screen.getByRole("region", { name: "Create a project" }),
    ).toHaveClass(
      "motion-safe:slide-out-to-right",
      "motion-safe:duration-300",
      "pointer-events-none",
    );
  });

  it("portals project task details above the project modal backdrop", () => {
    const { container } = renderList({
      mode: "overlay",
      selectedTaskId: "create-project",
    });
    const region = screen.getByRole("region", { name: "Create a project" });

    expect(region).toHaveClass("bottom-28", "z-[55]");
    expect(container).not.toContainElement(region);
    expect(document.body).toContainElement(region);
  });

  it("keeps the sticky accessible name unambiguous during crossfades", () => {
    renderList({ selectedTaskId: "start-chat" });

    expect(screen.getByRole("region", { name: "Start a chat" })).toBeVisible();
    expect(
      document.querySelectorAll("[id='starter-task-list-title']"),
    ).toHaveLength(0);
  });

  it("honors a controlled null selection instead of stale local state", async () => {
    const { rerender } = renderList();
    fireEvent.click(
      screen.getByRole("button", { name: "Open task: Start a chat" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Start a chat" }),
    ).toBeVisible();

    rerender(
      <StarterTaskList
        completionState={incomplete}
        mode="canvas"
        selectedTaskId={null}
        labels={labels}
        onTaskSelect={vi.fn()}
        onTaskToggle={vi.fn()}
        onBackHome={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Starter task list" }),
    ).toBeVisible();
  });

  it("closes only the secondary sticky with an accurate accessible label", () => {
    const onCloseSecondary = vi.fn();
    const onDismiss = vi.fn();
    renderList({
      mode: "overlay",
      selectedTaskId: "start-chat",
      onCloseSecondary,
      onDismiss,
    });

    fireEvent.click(screen.getByRole("button", { name: "Close task details" }));

    expect(onCloseSecondary).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("returns Home from task details in overlay mode", () => {
    const onBackHome = vi.fn();
    renderList({ mode: "overlay", onBackHome });

    fireEvent.click(
      screen.getByRole("button", { name: "Open task: Start a chat" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Back to starter tasks" }),
    );

    expect(onBackHome).toHaveBeenCalledOnce();
  });

  it("omits tasks completed in an earlier onboarding flow", () => {
    renderList({ omittedTaskIds: new Set(["connect-provider"]) });

    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(
      screen.queryByRole("button", {
        name: "Open task: Connect an AI provider",
      }),
    ).not.toBeInTheDocument();
  });

  it("checks completed tasks while keeping task navigation available", () => {
    renderList({
      completionState: { ...incomplete, "connect-provider": true },
    });
    const task = screen.getByRole("button", {
      name: "Completed task: Connect an AI provider",
    });
    expect(task).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Uncheck Connect an AI provider" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(within(task).getByText("Connect an AI provider")).toHaveClass(
      "line-through",
    );
    expect(
      task.parentElement?.querySelector(".lucide-arrow-right"),
    ).toBeInTheDocument();
  });

  it("drags the overlay by its header without jumping", () => {
    renderList({ mode: "overlay" });
    const region = screen.getByRole("region", { name: "Starter task list" });
    const header = screen.getByRole("heading", {
      name: "Starter task list",
    }).parentElement;
    vi.spyOn(region, "getBoundingClientRect").mockReturnValue({
      left: 700,
      top: 500,
      right: 956,
      bottom: 696,
      width: 256,
      height: 196,
      x: 700,
      y: 500,
      toJSON: () => ({}),
    });

    expect(header).not.toBeNull();
    if (!header) return;
    header.setPointerCapture = vi.fn();
    const downEvent = new Event("pointerdown", { bubbles: true });
    Object.defineProperties(downEvent, {
      button: { value: 0 },
      clientX: { value: 720 },
      clientY: { value: 520 },
      pointerId: { value: 1 },
    });
    fireEvent(header, downEvent);
    const moveEvent = new Event("pointermove", { bubbles: true });
    Object.defineProperties(moveEvent, {
      clientX: { value: 420 },
      clientY: { value: 320 },
    });
    fireEvent(window, moveEvent);
    fireEvent.pointerUp(window, { pointerId: 1 });

    expect(region).toHaveStyle({ left: "400px", top: "300px" });
    expect(region).toHaveClass("right-auto", "bottom-auto");
  });

  it("re-clamps a moved overlay when the viewport shrinks", () => {
    renderList({ mode: "overlay" });
    const region = screen.getByRole("region", { name: "Starter task list" });
    const header = screen.getByRole("heading", {
      name: "Starter task list",
    }).parentElement;
    vi.spyOn(region, "getBoundingClientRect").mockReturnValue({
      left: 700,
      top: 500,
      right: 956,
      bottom: 696,
      width: 256,
      height: 196,
      x: 700,
      y: 500,
      toJSON: () => ({}),
    });
    if (!header) throw new Error("missing draggable header");
    header.setPointerCapture = vi.fn();
    const downEvent = new Event("pointerdown", { bubbles: true });
    Object.defineProperties(downEvent, {
      button: { value: 0 },
      clientX: { value: 720 },
      clientY: { value: 520 },
      pointerId: { value: 1 },
    });
    fireEvent(header, downEvent);
    const moveEvent = new Event("pointermove", { bubbles: true });
    Object.defineProperties(moveEvent, {
      clientX: { value: 900 },
      clientY: { value: 700 },
    });
    fireEvent(window, moveEvent);
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: 600 },
      innerHeight: { configurable: true, value: 500 },
    });
    fireEvent(window, new Event("resize"));

    expect(region).toHaveStyle({ left: "336px", top: "296px" });
  });

  it("fills the canvas frame and only fixes the overlay mode", () => {
    const { rerender } = renderList();
    const region = screen.getByRole("region", { name: "Starter task list" });
    expect(region).toHaveAttribute("data-mode", "canvas");
    expect(region).not.toHaveClass("fixed");

    rerender(
      <StarterTaskList
        completionState={incomplete}
        mode="overlay"
        labels={labels}
        onTaskSelect={vi.fn()}
        onTaskToggle={vi.fn()}
        onBackHome={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(region).toHaveClass(
      "fixed",
      "h-auto",
      "w-[min(16rem,calc(100vw-2rem))]",
      "smooth-shadow-sm",
    );
  });
});
