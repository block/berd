import type React from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWidgetDragSuppression } from "./useWidgetDragSuppression";

function pointerEvent(clientX: number, clientY: number) {
  return { clientX, clientY } as React.PointerEvent;
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
    const { result } = renderHook(() => useWidgetDragSuppression());

    act(() => {
      result.current.handlePointerDownCapture(pointerEvent(10, 10));
      result.current.handlePointerMoveCapture(pointerEvent(13, 10));
      result.current.handlePointerUpCapture(pointerEvent(13, 10));
    });

    expect(result.current.shouldIgnoreActivation()).toBe(false);
  });

  it("suppresses activation for movement above the threshold", () => {
    const { result } = renderHook(() => useWidgetDragSuppression());

    act(() => {
      result.current.handlePointerDownCapture(pointerEvent(10, 10));
      result.current.handlePointerMoveCapture(pointerEvent(14, 10));
    });

    expect(result.current.shouldIgnoreActivation()).toBe(true);
  });

  it("suppresses the next click after drag-end offset above the threshold", () => {
    const { result } = renderHook(() => useWidgetDragSuppression());
    const clickEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      result.current.handleDragEnd({ x: 4, y: 0 });
    });
    window.dispatchEvent(clickEvent);

    expect(clickEvent.defaultPrevented).toBe(true);
  });

  it("clears suppression after 600ms", () => {
    const { result } = renderHook(() => useWidgetDragSuppression());

    act(() => {
      result.current.handleDragEnd({ x: 4, y: 0 });
    });
    expect(result.current.shouldIgnoreActivation()).toBe(true);

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(result.current.shouldIgnoreActivation()).toBe(false);
  });

  it("clears stale suppression when a new pointer interaction starts", () => {
    const { result } = renderHook(() => useWidgetDragSuppression());
    const clickEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      result.current.handleDragEnd({ x: 4, y: 0 });
    });
    expect(result.current.shouldIgnoreActivation()).toBe(true);

    act(() => {
      result.current.handlePointerDownCapture(pointerEvent(20, 20));
    });
    window.dispatchEvent(clickEvent);

    expect(result.current.shouldIgnoreActivation()).toBe(false);
    expect(clickEvent.defaultPrevented).toBe(false);
  });

  it("clears timers and listeners on unmount", () => {
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    const { result, unmount } = renderHook(() => useWidgetDragSuppression());

    act(() => {
      result.current.handleDragEnd({ x: 4, y: 0 });
    });
    unmount();

    expect(clearTimeout).toHaveBeenCalled();
    expect(removeEventListener).toHaveBeenCalledWith(
      "click",
      expect.any(Function),
      { capture: true },
    );
  });
});
