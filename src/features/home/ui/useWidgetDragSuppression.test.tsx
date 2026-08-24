import type React from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWidgetDragSuppression } from "./useWidgetDragSuppression";

const ABOVE_THRESHOLD_OFFSET = { x: 4, y: 0 };

function pointerEvent(clientX: number, clientY: number) {
  return { clientX, clientY } as React.PointerEvent<HTMLDivElement>;
}

function clickEvent() {
  return new MouseEvent("click", { bubbles: true, cancelable: true });
}

function renderSuppressedHook() {
  const rendered = renderHook(() => useWidgetDragSuppression());

  act(() => {
    rendered.result.current.suppressClickAfterDrag(ABOVE_THRESHOLD_OFFSET);
  });

  return rendered;
}

function renderAfterPointerMove(clientX: number) {
  const rendered = renderHook(() => useWidgetDragSuppression());
  const { frameHandlers } = rendered.result.current;

  act(() => {
    frameHandlers.onPointerDownCapture(pointerEvent(10, 10));
    frameHandlers.onPointerMoveCapture(pointerEvent(clientX, 10));
  });

  return rendered;
}

describe("useWidgetDragSuppression", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not suppress activation for movement at the threshold", () => {
    const { result } = renderAfterPointerMove(13);

    act(() => {
      result.current.frameHandlers.onPointerUpCapture(pointerEvent(13, 10));
    });

    expect(result.current.shouldIgnoreActivation()).toBe(false);
  });

  it("suppresses activation for movement above the threshold", () => {
    const { result } = renderAfterPointerMove(14);

    expect(result.current.shouldIgnoreActivation()).toBe(true);
  });

  it("suppresses the next click after drag-end offset above the threshold", () => {
    renderSuppressedHook();
    const event = clickEvent();

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("suppresses activation after a cancelled pointer sequence", () => {
    const { result } = renderHook(() => useWidgetDragSuppression());

    act(() => {
      result.current.frameHandlers.onPointerDownCapture(pointerEvent(10, 10));
      result.current.frameHandlers.onPointerCancelCapture(pointerEvent(10, 10));
    });

    expect(result.current.shouldIgnoreActivation()).toBe(true);
    const event = clickEvent();
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("clears suppression after 600ms", () => {
    const { result } = renderSuppressedHook();
    expect(result.current.shouldIgnoreActivation()).toBe(true);

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(result.current.shouldIgnoreActivation()).toBe(false);
  });

  it("clears stale suppression when a new pointer interaction starts", () => {
    const { result } = renderSuppressedHook();
    expect(result.current.shouldIgnoreActivation()).toBe(true);

    act(() => {
      result.current.frameHandlers.onPointerDownCapture(pointerEvent(20, 20));
    });
    const event = clickEvent();
    window.dispatchEvent(event);

    expect(result.current.shouldIgnoreActivation()).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it("clears timers and listeners on unmount", () => {
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    const { unmount } = renderSuppressedHook();
    unmount();

    expect(clearTimeout).toHaveBeenCalled();
    expect(removeEventListener).toHaveBeenCalledWith(
      "click",
      expect.any(Function),
      { capture: true },
    );
  });
});
