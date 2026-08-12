import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { useHomeCanvasViewport } from "./useHomeCanvasViewport";

const camera = {
  centerX: 0,
  centerY: 0,
  zoomBps: 10_000,
};

const constraints = {
  minCenter: -100_000,
  maxCenter: 100_000,
  minSize: 1,
  maxSize: 10_000,
  minZoomBps: 1_000,
  maxZoomBps: 20_000,
  maxTitleOverrideLength: 120,
  maxItems: 100,
};

const instance = {
  id: "agent-widget",
  type: "agentPin" as const,
  x: 20,
  y: 30,
  z: 1,
  state: { agentId: "agent-1" },
};

const widgetStart = { clientX: 24, clientY: 34 };
const panStart = { clientX: 100, clientY: 120 };
const panEnd = { clientX: 124, clientY: 96 };

type HookOptions = Parameters<typeof useHomeCanvasViewport>[0];
type HookResult = ReturnType<typeof useHomeCanvasViewport>;
type Point = { x: number; y: number };
type WebkitSelectionStyle = CSSStyleDeclaration & {
  webkitUserSelect?: string;
};

function pointerEvent({
  button = 0,
  pointerId = 1,
  type,
  clientX,
  clientY,
  currentTarget = document.createElement("div"),
}: {
  button?: number;
  pointerId?: number;
  type?: string;
  clientX: number;
  clientY: number;
  currentTarget?: HTMLElement;
}) {
  return {
    button,
    pointerId,
    type,
    clientX,
    clientY,
    currentTarget,
  } as React.PointerEvent<HTMLElement>;
}

type PointerEventOptions = Parameters<typeof pointerEvent>[0];

function wheelEvent({
  clientX,
  clientY,
  deltaX = 0,
  deltaY,
  ctrlKey = false,
  metaKey = false,
}: {
  clientX: number;
  clientY: number;
  deltaX?: number;
  deltaY: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
}) {
  return {
    preventDefault: vi.fn(),
    clientX,
    clientY,
    ctrlKey,
    metaKey,
    deltaX,
    deltaY,
    deltaMode: 0,
  } as unknown as React.WheelEvent<HTMLElement>;
}

function canvasElement() {
  const element = document.createElement("div");
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    width: 800,
    height: 600,
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return element;
}

function attachCanvasRef(
  canvasRef: React.RefObject<HTMLDivElement | null>,
  element: HTMLDivElement,
) {
  (canvasRef as { current: HTMLDivElement | null }).current = element;
}

function renderViewportHook(options: Partial<HookOptions> = {}) {
  return renderHook(() =>
    useHomeCanvasViewport({
      camera,
      constraints,
      saveCamera: vi.fn(),
      ...options,
    }),
  );
}

function beginWidgetDrag(
  viewport: HookResult,
  currentTarget = document.createElement("div"),
  event: Partial<PointerEventOptions> = {},
) {
  viewport.beginWidgetDrag(
    pointerEvent({ ...widgetStart, currentTarget, ...event }),
    instance,
  );
}

function expectWidgetDragEnd(
  onWidgetDragEnd: ReturnType<typeof vi.fn>,
  position: Point,
  offset: Point,
) {
  expect(onWidgetDragEnd).toHaveBeenCalledWith({
    id: "agent-widget",
    position,
    offset,
  });
}

function renderViewportWithPendingWheelSave(
  options: Partial<HookOptions> = {},
) {
  vi.useFakeTimers();
  const saveCamera = options.saveCamera ?? vi.fn();
  const hook = renderViewportHook({ ...options, saveCamera });
  const canvas = canvasElement();
  attachCanvasRef(hook.result.current.canvasRef, canvas);

  act(() => {
    hook.result.current.handleWheel(
      wheelEvent({ clientX: 400, clientY: 300, ctrlKey: true, deltaY: -120 }),
    );
  });
  expect(saveCamera).not.toHaveBeenCalled();

  return { ...hook, canvas, saveCamera };
}

function advanceCameraSaveTimer() {
  act(() => {
    vi.advanceTimersByTime(150);
  });
}

function setWebkitUserSelect(style: CSSStyleDeclaration, value: string) {
  (style as WebkitSelectionStyle).webkitUserSelect = value;
}

function webkitUserSelect(style: CSSStyleDeclaration) {
  return (style as WebkitSelectionStyle).webkitUserSelect;
}

describe("useHomeCanvasViewport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.style.userSelect = "";
    document.body.style.removeProperty("-webkit-user-select");
    setWebkitUserSelect(document.body.style, "");
    document.documentElement.style.userSelect = "";
    document.documentElement.style.removeProperty("-webkit-user-select");
    setWebkitUserSelect(document.documentElement.style, "");
  });

  it("does not capture the pointer until widget movement crosses the drag threshold", () => {
    const onWidgetDragEnd = vi.fn();
    const captureElement = document.createElement("div");
    const { result } = renderViewportHook({ onWidgetDragEnd });

    act(() => {
      beginWidgetDrag(result.current, captureElement);
    });
    expect(captureElement.setPointerCapture).not.toHaveBeenCalled();

    act(() => {
      result.current.handlePointerMove(
        pointerEvent({ clientX: 28, clientY: 34 }),
      );
      result.current.finishPointerGesture(
        pointerEvent({ clientX: 28, clientY: 34 }),
      );
    });

    expect(captureElement.setPointerCapture).toHaveBeenCalledWith(1);
    expectWidgetDragEnd(onWidgetDragEnd, { x: 24, y: 30 }, { x: 4, y: 0 });
  });

  it("uses the final pointer-up position when threshold is crossed on pointer up", () => {
    const onWidgetDragEnd = vi.fn();
    const captureElement = document.createElement("div");
    const { result } = renderViewportHook({ onWidgetDragEnd });

    act(() => {
      beginWidgetDrag(result.current, captureElement);
      result.current.finishPointerGesture(
        pointerEvent({ clientX: 29, clientY: 32 }),
      );
    });

    expect(captureElement.setPointerCapture).not.toHaveBeenCalled();
    expectWidgetDragEnd(onWidgetDragEnd, { x: 25, y: 28 }, { x: 5, y: -2 });
  });

  it("ignores non-primary widget pointer gestures", () => {
    const onWidgetDragEnd = vi.fn();
    const captureElement = document.createElement("div");
    const { result } = renderViewportHook({ onWidgetDragEnd });

    act(() => {
      beginWidgetDrag(result.current, captureElement, { button: 2 });
      result.current.handlePointerMove(
        pointerEvent({ button: 2, clientX: 40, clientY: 34 }),
      );
      result.current.finishPointerGesture(
        pointerEvent({ button: 2, clientX: 40, clientY: 34 }),
      );
    });

    expect(captureElement.setPointerCapture).not.toHaveBeenCalled();
    expect(onWidgetDragEnd).not.toHaveBeenCalled();
  });

  it("cancels active pan gestures without saving the camera", () => {
    const saveCamera = vi.fn();
    const captureElement = document.createElement("div");
    const { result } = renderViewportHook({ saveCamera });
    const startViewport = result.current.viewport;

    act(() => {
      result.current.beginPan(
        pointerEvent({
          ...panStart,
          currentTarget: captureElement,
        }),
      );
      result.current.handlePointerMove(pointerEvent(panEnd));
    });
    expect(result.current.viewport).not.toEqual(startViewport);

    act(() => {
      result.current.finishPointerGesture(
        pointerEvent({
          ...panEnd,
          type: "pointercancel",
        }),
      );
    });

    expect(captureElement.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(result.current.viewport).toEqual(startViewport);
    expect(saveCamera).not.toHaveBeenCalled();
  });

  it("cancels active widget drags without committing them", () => {
    const saveCamera = vi.fn();
    const onWidgetDragEnd = vi.fn();
    const captureElement = document.createElement("div");
    const { result } = renderViewportHook({ saveCamera, onWidgetDragEnd });

    act(() => {
      beginWidgetDrag(result.current, captureElement);
      result.current.handlePointerMove(
        pointerEvent({ clientX: 30, clientY: 34 }),
      );
    });
    expect(result.current.dragPositions).toEqual({
      "agent-widget": { x: 26, y: 30 },
    });

    act(() => {
      result.current.finishPointerGesture(
        pointerEvent({
          type: "pointercancel",
          clientX: 30,
          clientY: 34,
        }),
      );
    });

    expect(captureElement.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(result.current.dragPositions).toEqual({});
    expect(onWidgetDragEnd).not.toHaveBeenCalled();
    expect(saveCamera).not.toHaveBeenCalled();
  });

  it("does not save the camera for a pan gesture without movement", () => {
    const saveCamera = vi.fn();
    const captureElement = document.createElement("div");
    const { result } = renderViewportHook({ saveCamera });

    act(() => {
      result.current.beginPan(
        pointerEvent({
          ...panStart,
          currentTarget: captureElement,
        }),
      );
      result.current.finishPointerGesture(pointerEvent(panStart));
    });

    expect(saveCamera).not.toHaveBeenCalled();
  });

  it("disables document text selection only while a canvas gesture is active", () => {
    const captureElement = document.createElement("div");
    document.body.style.userSelect = "text";
    setWebkitUserSelect(document.body.style, "text");
    document.documentElement.style.userSelect = "text";
    setWebkitUserSelect(document.documentElement.style, "text");
    const { result } = renderViewportHook();

    act(() => {
      result.current.beginPan(
        pointerEvent({
          ...panStart,
          currentTarget: captureElement,
        }),
      );
    });

    expect(document.body.style.userSelect).toBe("none");
    expect(webkitUserSelect(document.body.style)).toBe("none");
    expect(document.documentElement.style.userSelect).toBe("none");
    expect(webkitUserSelect(document.documentElement.style)).toBe("none");

    act(() => {
      result.current.finishPointerGesture(pointerEvent(panStart));
    });

    expect(document.body.style.userSelect).toBe("text");
    expect(webkitUserSelect(document.body.style)).toBe("text");
    expect(document.documentElement.style.userSelect).toBe("text");
    expect(webkitUserSelect(document.documentElement.style)).toBe("text");
  });

  it("does not disable document text selection for click-like widget gestures", () => {
    const captureElement = document.createElement("div");
    document.body.style.userSelect = "text";
    const { result } = renderViewportHook();

    act(() => {
      beginWidgetDrag(result.current, captureElement);
    });

    expect(document.body.style.userSelect).toBe("text");

    act(() => {
      result.current.finishPointerGesture(pointerEvent(widgetStart));
    });

    expect(document.body.style.userSelect).toBe("text");
  });

  it("disables document text selection only while a widget is dragging", () => {
    const captureElement = document.createElement("div");
    document.body.style.userSelect = "text";
    const { result } = renderViewportHook();

    act(() => {
      beginWidgetDrag(result.current, captureElement);
      result.current.handlePointerMove(
        pointerEvent({ clientX: 30, clientY: 34 }),
      );
    });

    expect(document.body.style.userSelect).toBe("none");

    act(() => {
      result.current.finishPointerGesture(
        pointerEvent({ clientX: 30, clientY: 34 }),
      );
    });

    expect(document.body.style.userSelect).toBe("text");
  });

  it("clears a pending wheel save before committing a pan camera", () => {
    const { result, canvas, saveCamera } = renderViewportWithPendingWheelSave();

    act(() => {
      result.current.beginPan(
        pointerEvent({
          ...panStart,
          currentTarget: canvas,
        }),
      );
      result.current.finishPointerGesture(pointerEvent(panEnd));
    });
    expect(saveCamera).toHaveBeenCalledTimes(1);

    advanceCameraSaveTimer();
    expect(saveCamera).toHaveBeenCalledTimes(1);
  });

  it("clears a pending wheel save before committing a widget drag", () => {
    const onWidgetDragEnd = vi.fn();
    const { result, saveCamera } = renderViewportWithPendingWheelSave({
      onWidgetDragEnd,
    });

    act(() => {
      beginWidgetDrag(result.current);
      result.current.finishPointerGesture(
        pointerEvent({ clientX: 30, clientY: 34 }),
      );
    });

    expect(onWidgetDragEnd).toHaveBeenCalledTimes(1);
    advanceCameraSaveTimer();
    expect(saveCamera).not.toHaveBeenCalled();
  });

  it("keeps the final drag preview in place while committing the widget move", () => {
    let previewDuringCommit: Point | undefined;
    const { result } = renderViewportHook({
      onWidgetDragEnd: vi.fn(() => {
        previewDuringCommit = result.current.dragPositions["agent-widget"];
      }),
    });

    act(() => {
      beginWidgetDrag(result.current);
      result.current.handlePointerMove(
        pointerEvent({ clientX: 30, clientY: 34 }),
      );
    });

    expect(result.current.dragPositions).toEqual({
      "agent-widget": { x: 26, y: 30 },
    });

    act(() => {
      result.current.finishPointerGesture(
        pointerEvent({ clientX: 30, clientY: 34 }),
      );
    });

    expect(previewDuringCommit).toEqual({ x: 26, y: 30 });
    expect(result.current.dragPositions).toEqual({});
  });

  it("uses the pointerdown zoom when converting widget drag movement", () => {
    const onWidgetDragEnd = vi.fn();
    const { result, rerender } = renderHook(
      ({ currentCamera }) =>
        useHomeCanvasViewport({
          camera: currentCamera,
          constraints,
          saveCamera: vi.fn(),
          onWidgetDragEnd,
        }),
      { initialProps: { currentCamera: camera } },
    );

    act(() => {
      beginWidgetDrag(result.current);
    });

    rerender({
      currentCamera: {
        ...camera,
        zoomBps: 20_000,
      },
    });

    act(() => {
      result.current.handlePointerMove(
        pointerEvent({ clientX: 34, clientY: 34 }),
      );
      result.current.finishPointerGesture(
        pointerEvent({ clientX: 34, clientY: 34 }),
      );
    });

    expectWidgetDragEnd(onWidgetDragEnd, { x: 30, y: 30 }, { x: 10, y: 0 });
  });

  it("saves non-centered wheel zooms around the cursor", () => {
    vi.useFakeTimers();
    const saveCamera = vi.fn();
    const hook = renderHook(
      ({ currentCamera }) =>
        useHomeCanvasViewport({
          camera: currentCamera,
          constraints,
          saveCamera,
        }),
      { initialProps: { currentCamera: camera } },
    );
    const canvas = canvasElement();

    attachCanvasRef(hook.result.current.canvasRef, canvas);
    hook.rerender({ currentCamera: { ...camera } });

    act(() => {
      hook.result.current.handleWheel(
        wheelEvent({ clientX: 100, clientY: 120, ctrlKey: true, deltaY: -120 }),
      );
    });
    advanceCameraSaveTimer();

    expect(saveCamera).toHaveBeenCalledWith({
      centerX: expect.any(Number),
      centerY: expect.any(Number),
      zoomBps: expect.any(Number),
    });
    expect(saveCamera.mock.calls[0][0].centerX).toBeLessThan(0);
    expect(saveCamera.mock.calls[0][0].centerY).toBeLessThan(0);
    expect(saveCamera.mock.calls[0][0].zoomBps).toBeGreaterThan(10_000);
  });

  it("rebuilds the viewport from the persisted camera once canvas size is known", () => {
    const persistedCamera = { ...camera, centerX: 120, centerY: -80 };
    const { result, rerender } = renderHook(
      ({ currentCamera }) =>
        useHomeCanvasViewport({
          camera: currentCamera,
          constraints,
          saveCamera: vi.fn(),
        }),
      { initialProps: { currentCamera: persistedCamera } },
    );
    const canvas = canvasElement();

    attachCanvasRef(result.current.canvasRef, canvas);
    rerender({ currentCamera: { ...persistedCamera } });

    expect(result.current.viewport).toEqual({
      x: 280,
      y: 380,
      zoom: 1,
    });
    expect(result.current.canvasSize).toEqual({ width: 800, height: 600 });
  });
});
