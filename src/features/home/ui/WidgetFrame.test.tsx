import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("commits z-index changes when opening the context menu", () => {
    const bumpZ = vi.fn();

    const { frame } = renderWidgetFrame({
      currentMaxZ: 2,
      mutations: mutationHandlers({ bumpZ }),
    });

    fireEvent.contextMenu(frame);

    expect(bumpZ).toHaveBeenCalledWith("clock-1");
  });

  it("renders the context menu above widget frames", () => {
    const { frame } = renderWidgetFrame();

    fireEvent.contextMenu(frame);

    expect(screen.getByRole("menu")).toHaveClass("z-[1000]");
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

  it("removes the widget from the context menu", async () => {
    const user = userEvent.setup();
    const removeWidget = vi.fn();
    const { frame } = renderWidgetFrame({
      mutations: mutationHandlers({ removeWidget }),
    });

    fireEvent.contextMenu(frame);
    await user.click(screen.getByRole("menuitem", { name: "Remove" }));

    expect(removeWidget).toHaveBeenCalledWith("clock-1");
  });

  it.each([
    ["Delete", "{Delete}"],
    ["Backspace", "{Backspace}"],
  ])("removes a focused non-interactive widget with %s", async (_, key) => {
    const user = userEvent.setup();
    const removeWidget = vi.fn();
    const { frame } = renderWidgetFrame({
      mutations: mutationHandlers({ removeWidget }),
    });

    await user.tab();
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
});
