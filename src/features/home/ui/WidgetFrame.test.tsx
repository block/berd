import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeFreshWidgetPlacement,
  markFreshWidgetPlacement,
} from "../lib/freshWidgetPlacements";
import type {
  WidgetInstance,
  WidgetMutationHandlers,
  WidgetNavigationHandlers,
} from "../widgets/types";
import { WidgetFrame } from "./WidgetFrame";
import type { WidgetFrameGestureHandlers } from "./useWidgetDragSuppression";

const clockInstance = {
  id: "clock-1",
  type: "clock",
  x: 20,
  y: 30,
  z: 1,
} satisfies WidgetInstance;

const agentPinInstance = {
  id: "agent-pin-1",
  type: "agentPin",
  x: 20,
  y: 30,
  z: 1,
  state: { agentId: "agent-1" },
} satisfies WidgetInstance;

vi.mock("@/features/agents/stores/agentStore", () => ({
  useAgentStore: (selector: (state: unknown) => unknown) =>
    selector({
      personas: [
        {
          id: "agent-1",
          displayName: "Agent One",
          isBuiltin: false,
        },
      ],
    }),
}));

function mutationHandlers(
  overrides: Partial<WidgetMutationHandlers> = {},
): WidgetMutationHandlers {
  return {
    addWidget: vi.fn(),
    moveWidget: vi.fn(),
    resizeWidget: vi.fn(),
    bumpZ: vi.fn(),
    removeWidget: vi.fn(),
    updateWidgetState: vi.fn(),
    ...overrides,
  };
}

function renderWidgetFrame({
  currentMaxZ = 1,
  instance = clockInstance,
  mutations = mutationHandlers(),
  navigation,
  shouldIgnoreActivation,
  gestureHandlers,
  onVisualLiftReset,
}: {
  currentMaxZ?: number;
  instance?: WidgetInstance;
  mutations?: WidgetMutationHandlers;
  navigation?: WidgetNavigationHandlers;
  shouldIgnoreActivation?: () => boolean;
  gestureHandlers?: Partial<WidgetFrameGestureHandlers>;
  onVisualLiftReset?: (id: string) => void;
} = {}) {
  const result = render(
    <WidgetFrame
      instance={instance}
      currentMaxZ={currentMaxZ}
      mutations={mutations}
      shouldIgnoreActivation={shouldIgnoreActivation}
      gestureHandlers={gestureHandlers}
      onVisualLiftReset={onVisualLiftReset}
      {...navigation}
    />,
  );

  const frame = result.getByRole("group");

  return { ...result, frame };
}

describe("WidgetFrame", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not lift or commit z-index changes on pointer down", () => {
    const bumpZ = vi.fn();

    const { frame } = renderWidgetFrame({
      currentMaxZ: 2,
      mutations: mutationHandlers({ bumpZ }),
    });

    fireEvent.pointerDown(frame, { clientX: 20, clientY: 30 });

    expect(bumpZ).not.toHaveBeenCalled();
  });

  it("commits z-index changes on click after pointer down", () => {
    const bumpZ = vi.fn();

    const { frame } = renderWidgetFrame({
      currentMaxZ: 2,
      mutations: mutationHandlers({ bumpZ }),
    });

    fireEvent.pointerDown(frame, { clientX: 20, clientY: 30 });
    fireEvent.click(frame);

    expect(bumpZ).toHaveBeenCalledWith("clock-1");
  });

  it("does not commit z-index changes when opening the unpin pill", () => {
    const bumpZ = vi.fn();

    const { frame } = renderWidgetFrame({
      currentMaxZ: 2,
      mutations: mutationHandlers({ bumpZ }),
    });

    fireEvent.contextMenu(frame);

    expect(bumpZ).not.toHaveBeenCalled();
  });

  it("prevents the canvas pin menu from opening when right-clicking a widget", () => {
    const parentContextMenu = vi.fn();
    const { container } = render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test fixture stands in for the canvas's context-menu handler
      <div onContextMenu={parentContextMenu}>
        <WidgetFrame
          instance={clockInstance}
          currentMaxZ={1}
          mutations={mutationHandlers()}
        />
      </div>,
    );

    const frame = container.querySelector("fieldset");
    expect(frame).not.toBeNull();

    const event = createEvent.contextMenu(frame as Element, {
      clientX: 50,
      clientY: 60,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(frame as Element, event);

    expect(event.defaultPrevented).toBe(true);
    expect(parentContextMenu).not.toHaveBeenCalled();
  });

  it("resets visual z-index lift when the pointer is canceled", () => {
    const onVisualLiftReset = vi.fn();

    const { frame } = renderWidgetFrame({
      currentMaxZ: 2,
      onVisualLiftReset,
    });

    fireEvent.pointerCancel(frame);

    expect(onVisualLiftReset).toHaveBeenCalledWith("clock-1");
  });

  it("passes gesture handlers to the frame", () => {
    const gestureHandlers = {
      onPointerDownCapture: vi.fn(),
      onPointerMoveCapture: vi.fn(),
      onPointerUpCapture: vi.fn(),
      onPointerCancelCapture: vi.fn(),
      onClickCapture: vi.fn(),
    } satisfies Partial<WidgetFrameGestureHandlers>;

    const { frame } = renderWidgetFrame({
      gestureHandlers,
    });

    fireEvent.pointerDown(frame, { clientX: 20, clientY: 30 });
    fireEvent.pointerMove(frame, { clientX: 26, clientY: 30 });
    fireEvent.pointerUp(frame, { clientX: 26, clientY: 30 });
    fireEvent.pointerCancel(frame);
    fireEvent.click(frame);

    for (const handler of Object.values(gestureHandlers)) {
      expect(handler).toHaveBeenCalled();
    }
  });

  it("preserves widget click activation before committing z-index changes", () => {
    const bumpZ = vi.fn();
    const onOpenAgent = vi.fn();

    renderWidgetFrame({
      currentMaxZ: 2,
      instance: agentPinInstance,
      mutations: mutationHandlers({ bumpZ }),
      navigation: { onOpenAgent },
    });

    fireEvent.click(screen.getByRole("button", { name: /agent one/i }));

    expect(onOpenAgent).toHaveBeenCalledWith("agent-1");
    expect(bumpZ).toHaveBeenCalledWith("agent-pin-1");
    expect(onOpenAgent.mock.invocationCallOrder[0]).toBeLessThan(
      bumpZ.mock.invocationCallOrder[0],
    );
  });

  it("suppresses child widget activation when the drag guard is active", () => {
    const onOpenAgent = vi.fn();

    renderWidgetFrame({
      instance: agentPinInstance,
      navigation: { onOpenAgent },
      shouldIgnoreActivation: () => true,
    });

    fireEvent.click(screen.getByRole("button", { name: /agent one/i }));

    expect(onOpenAgent).not.toHaveBeenCalled();
  });

  it("unpins a pin widget via the unpin pill on right-click", async () => {
    const user = userEvent.setup();
    const removeWidget = vi.fn();
    const { frame } = renderWidgetFrame({
      instance: agentPinInstance,
      mutations: mutationHandlers({ removeWidget }),
    });

    fireEvent.contextMenu(frame, { clientX: 40, clientY: 50 });
    await user.click(screen.getByRole("button", { name: "Unpin" }));

    expect(removeWidget).toHaveBeenCalledWith("agent-pin-1");
  });

  it("opens the unpin pill when right-clicking the clock", async () => {
    const user = userEvent.setup();
    const removeWidget = vi.fn();
    const { frame } = renderWidgetFrame({
      mutations: mutationHandlers({ removeWidget }),
    });

    fireEvent.contextMenu(frame, { clientX: 40, clientY: 50 });
    await user.click(screen.getByRole("button", { name: "Unpin" }));

    expect(removeWidget).toHaveBeenCalledWith("clock-1");
  });

  it.each([
    ["Delete", "{Delete}"],
    ["Backspace", "{Backspace}"],
  ])("removes the clock on %s key", async (_, key) => {
    const user = userEvent.setup();
    const removeWidget = vi.fn();
    const { frame } = renderWidgetFrame({
      mutations: mutationHandlers({ removeWidget }),
    });

    frame.focus();
    expect(frame).toHaveFocus();

    await user.keyboard(key);

    expect(removeWidget).toHaveBeenCalledWith("clock-1");
  });

  it("does not remove an interactive widget when a child control handles keyboard input", async () => {
    const user = userEvent.setup();
    const removeWidget = vi.fn();

    renderWidgetFrame({
      instance: agentPinInstance,
      mutations: mutationHandlers({ removeWidget }),
    });

    screen.getByRole("button", { name: /agent one/i }).focus();
    await user.keyboard("{Delete}");

    expect(removeWidget).not.toHaveBeenCalled();
  });

  describe("placement settle animation", () => {
    afterEach(() => {
      // The mount effect normally consumes the entry, but keep the registry
      // clean even if a test fails before mounting.
      consumeFreshWidgetPlacement("clock-1");
    });

    it("plays the settle animation when the instance was freshly placed", () => {
      markFreshWidgetPlacement("clock-1");

      const { frame } = renderWidgetFrame();

      expect(frame).toHaveClass("animate-widget-settle");
    });

    it("does not play the settle animation on an ordinary mount", () => {
      const { frame } = renderWidgetFrame();

      expect(frame).not.toHaveClass("animate-widget-settle");
    });

    it("does not replay the settle animation when the widget remounts", () => {
      markFreshWidgetPlacement("clock-1");

      const first = renderWidgetFrame();
      expect(first.frame).toHaveClass("animate-widget-settle");
      first.unmount();

      // Returning to Home remounts the frame for the same instance — the
      // one-shot flag was consumed by the first committed mount.
      const second = renderWidgetFrame();
      expect(second.frame).not.toHaveClass("animate-widget-settle");
    });

    it("keeps the settle animation when a child animation ends", () => {
      markFreshWidgetPlacement("clock-1");

      const { frame } = renderWidgetFrame();
      expect(frame).toHaveClass("animate-widget-settle");

      // animationend bubbles: a child widget's own animation (e.g. the
      // clock's 180ms face fade) must not cancel the 380ms settle.
      const child = frame.querySelector("div");
      expect(child).not.toBeNull();
      if (child) {
        fireEvent.animationEnd(child, { animationName: "clock-face-fade" });
      }

      expect(frame).toHaveClass("animate-widget-settle");
    });

    it("clears the settle animation when the frame's own animation ends", () => {
      markFreshWidgetPlacement("clock-1");

      const { frame } = renderWidgetFrame();
      expect(frame).toHaveClass("animate-widget-settle");

      fireEvent.animationEnd(frame, { animationName: "widget-settle" });

      expect(frame).not.toHaveClass("animate-widget-settle");
    });
  });
});
