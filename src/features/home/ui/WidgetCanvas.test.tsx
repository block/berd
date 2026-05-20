import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LayoutCamera,
  LayoutConstraints,
} from "@/features/layout/api/layout";
import type {
  WidgetInstance,
  WidgetMutationHandlers,
  WidgetNavigationHandlers,
} from "../widgets/types";
import { WidgetCanvas } from "./WidgetCanvas";

const mocks = vi.hoisted(() => ({
  saveCamera: vi.fn(),
  homeWidgetState: {
    camera: { centerX: 0, centerY: 0, zoomBps: 10_000 } as LayoutCamera,
    constraints: null as LayoutConstraints | null,
  },
}));

vi.mock("../stores/homeWidgetStore", () => ({
  useHomeWidgetStore: (selector: (state: unknown) => unknown) =>
    selector({ ...mocks.homeWidgetState, saveCamera: mocks.saveCamera }),
}));

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

const CANVAS_CONSTRAINTS: LayoutConstraints = {
  minCenter: -1000,
  maxCenter: 1000,
  minSize: 1,
  maxSize: 10_000,
  minZoomBps: 1000,
  maxZoomBps: 20_000,
  maxTitleOverrideLength: 120,
  maxItems: 100,
};

function canvasRect({
  left = 0,
  top = 0,
  width = 800,
  height = 600,
}: Partial<Pick<DOMRect, "left" | "top" | "width" | "height">> = {}): DOMRect {
  return {
    width,
    height,
    left,
    top,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

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

function widget(overrides: Partial<WidgetInstance> = {}): WidgetInstance {
  return {
    id: "clock-widget",
    type: "clock",
    x: 20,
    y: 30,
    z: 1,
    ...overrides,
  };
}

function agentWidget(): WidgetInstance {
  return widget({
    id: "agent-widget",
    type: "agentPin",
    state: { agentId: "agent-1" },
  });
}

type RenderCanvasOptions = WidgetNavigationHandlers & {
  instances?: WidgetInstance[];
  mutations?: Partial<WidgetMutationHandlers>;
};

function renderCanvas({
  instances = [],
  mutations = {},
  ...navigation
}: RenderCanvasOptions = {}) {
  return render(
    <WidgetCanvas
      instances={instances}
      mutations={mutationHandlers(mutations)}
      {...navigation}
    />,
  );
}

describe("WidgetCanvas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mocks.homeWidgetState.camera = { centerX: 0, centerY: 0, zoomBps: 10_000 };
    mocks.homeWidgetState.constraints = null;
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("allows child widget clicks when the pointer does not drag", () => {
    const onOpenAgent = vi.fn();
    const bumpZ = vi.fn();
    const moveWidget = vi.fn();

    renderCanvas({
      instances: [agentWidget(), widget({ x: 300, z: 2 })],
      mutations: { bumpZ, moveWidget },
      onOpenAgent,
    });

    const agentButton = screen.getByRole("button", { name: /agent one/i });
    fireEvent.pointerDown(agentButton, {
      button: 0,
      pointerId: 1,
      clientX: 24,
      clientY: 34,
    });
    fireEvent.pointerUp(agentButton, {
      button: 0,
      pointerId: 1,
      clientX: 24,
      clientY: 34,
    });
    fireEvent.click(agentButton);

    expect(onOpenAgent).toHaveBeenCalledWith("agent-1");
    expect(bumpZ).toHaveBeenCalledWith("agent-widget");
    expect(moveWidget).not.toHaveBeenCalled();
    expect(HTMLElement.prototype.setPointerCapture).not.toHaveBeenCalled();
  });

  it("ignores non-primary widget pointer gestures", () => {
    const moveWidget = vi.fn();

    renderCanvas({
      instances: [agentWidget()],
      mutations: { moveWidget },
    });

    const agentButton = screen.getByRole("button", { name: /agent one/i });
    const agentNode = agentButton.closest("[data-home-widget-node]");
    expect(agentNode).not.toBeNull();
    fireEvent.pointerDown(agentNode as Element, {
      button: 2,
      pointerId: 1,
      clientX: 24,
      clientY: 34,
    });
    fireEvent.pointerMove(agentNode as Element, {
      button: 2,
      pointerId: 1,
      clientX: 40,
      clientY: 34,
    });
    fireEvent.pointerUp(agentNode as Element, {
      button: 2,
      pointerId: 1,
      clientX: 40,
      clientY: 34,
    });

    expect(moveWidget).not.toHaveBeenCalled();
    expect(HTMLElement.prototype.setPointerCapture).not.toHaveBeenCalled();
  });

  it("moves dragged widgets to the front with a single mutation", async () => {
    const user = userEvent.setup();
    const bumpZ = vi.fn();
    const moveWidget = vi.fn();
    mocks.homeWidgetState.constraints = CANVAS_CONSTRAINTS;

    const { container } = renderCanvas({
      instances: [widget(), widget({ id: "front-widget", x: 300, z: 2 })],
      mutations: { bumpZ, moveWidget },
    });

    const canvas = container.firstElementChild as Element;
    const clockNode = container.querySelector("[data-home-widget-node]");
    expect(clockNode).not.toBeNull();

    await user.pointer([
      {
        keys: "[MouseLeft>]",
        target: clockNode as Element,
        coords: { clientX: 24, clientY: 34 },
      },
      {
        target: canvas,
        coords: { clientX: 54, clientY: 82 },
      },
      {
        keys: "[/MouseLeft]",
        target: canvas,
        coords: { clientX: 54, clientY: 82 },
      },
    ]);

    expect(bumpZ).not.toHaveBeenCalled();
    expect(moveWidget).toHaveBeenCalledTimes(1);
    expect(moveWidget).toHaveBeenCalledWith(
      "clock-widget",
      50,
      78,
      CANVAS_CONSTRAINTS,
      { bringToFront: true },
    );
  });

  it("saves the camera after panning the canvas background", async () => {
    const user = userEvent.setup();
    const { container } = renderCanvas();
    const canvas = container.firstElementChild as HTMLElement;

    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect());

    await user.pointer([
      {
        keys: "[MouseLeft>]",
        target: canvas,
        coords: { clientX: 100, clientY: 120 },
      },
      {
        target: canvas,
        coords: { clientX: 124, clientY: 96 },
      },
      {
        keys: "[/MouseLeft]",
        target: canvas,
        coords: { clientX: 124, clientY: 96 },
      },
    ]);

    expect(mocks.saveCamera).toHaveBeenCalledWith({
      centerX: expect.any(Number),
      centerY: expect.any(Number),
      zoomBps: 10_000,
    });
  });

  it("saves the camera after wheel zoom settles", () => {
    vi.useFakeTimers();
    const { container } = renderCanvas();
    const canvas = container.firstElementChild as HTMLElement;

    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect());

    fireEvent.wheel(canvas, {
      clientX: 400,
      clientY: 300,
      deltaY: -120,
    });

    expect(mocks.saveCamera).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);

    expect(mocks.saveCamera).toHaveBeenCalledWith({
      centerX: expect.any(Number),
      centerY: expect.any(Number),
      zoomBps: expect.any(Number),
    });
    expect(mocks.saveCamera.mock.calls[0][0].zoomBps).toBeGreaterThan(10_000);
  });

  it("adds a widget from the picker after double-clicking the canvas", async () => {
    const user = userEvent.setup();
    const addWidget = vi.fn();
    mocks.homeWidgetState.camera = {
      centerX: 200,
      centerY: -100,
      zoomBps: 12_500,
    };
    mocks.homeWidgetState.constraints = CANVAS_CONSTRAINTS;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      canvasRect({ left: 25, top: 50, width: 1000, height: 800 }),
    );

    const { container } = renderCanvas({ mutations: { addWidget } });

    fireEvent.doubleClick(container.firstElementChild as Element, {
      clientX: 345,
      clientY: 290,
    });
    await user.click(screen.getByRole("button", { name: /display/i }));
    await user.click(screen.getByRole("menuitem", { name: /clock/i }));

    expect(addWidget).toHaveBeenCalledWith(
      "clock",
      56,
      -228,
      undefined,
      CANVAS_CONSTRAINTS,
    );
  });

  it("removes a widget from the context menu", async () => {
    const user = userEvent.setup();
    const removeWidget = vi.fn();

    renderCanvas({
      instances: [widget()],
      mutations: { removeWidget },
    });

    await user.pointer({
      keys: "[MouseRight]",
      target: screen.getByText(/wed|sun|mon|tue|thu|fri|sat/i),
    });
    await user.click(screen.getByText("Remove"));

    expect(removeWidget).toHaveBeenCalledWith("clock-widget");
    expect(HTMLElement.prototype.setPointerCapture).not.toHaveBeenCalled();
  });
});
