import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { StarterTaskList, type StarterTaskListLabels } from "./StarterTaskList";

const labels: StarterTaskListLabels = {
  title: "Starter task list",
  backHome: "Back to Home",
  dismiss: "Dismiss starter tasks",
  tasks: {
    "connect-provider": "Connect an AI provider",
    "start-chat": "Start a chat",
    "create-project": "Create a project",
    "build-agent": "Build an agent",
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
  "build-agent": false,
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
  it("renders all requested tasks and selects one", () => {
    const onTaskSelect = vi.fn();
    renderList({ onTaskSelect });
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    fireEvent.click(
      screen.getByRole("button", { name: "Open task: Start a chat" }),
    );
    expect(onTaskSelect).toHaveBeenCalledWith("start-chat");
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
