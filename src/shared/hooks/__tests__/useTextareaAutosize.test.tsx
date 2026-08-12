import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";

import { useTextareaAutosize } from "../useTextareaAutosize";

function setScrollHeight(textarea: HTMLTextAreaElement, scrollHeight: number) {
  Object.defineProperty(textarea, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
}

function installResizeObserverMock() {
  const callbacks = new Set<ResizeObserverCallback>();

  class ResizeObserverMock {
    constructor(private readonly callback: ResizeObserverCallback) {
      callbacks.add(callback);
    }

    observe() {}

    disconnect() {
      callbacks.delete(this.callback);
    }
  }

  vi.stubGlobal("ResizeObserver", ResizeObserverMock);

  return {
    emit(width: number) {
      for (const callback of callbacks) {
        callback(
          [
            {
              contentRect: { width } as DOMRectReadOnly,
            } as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      }
    },
  };
}

function useAutosizeHarness({
  maxHeight,
  textarea,
  value,
}: {
  maxHeight: number;
  textarea: HTMLTextAreaElement;
  value: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(textarea);
  return useTextareaAutosize({
    textareaRef,
    value,
    getMaxHeightPx: () => maxHeight,
  });
}

describe("useTextareaAutosize", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("resets and clamps height after value changes", () => {
    const textarea = document.createElement("textarea");
    setScrollHeight(textarea, 120);

    const { rerender } = renderHook(
      ({ value }) => useAutosizeHarness({ textarea, value, maxHeight: 80 }),
      { initialProps: { value: "hello" } },
    );

    expect(textarea.style.height).toBe("80px");

    setScrollHeight(textarea, 48);
    rerender({ value: "short" });

    expect(textarea.style.height).toBe("48px");
  });

  it("coalesces scheduled autosize work", () => {
    const textarea = document.createElement("textarea");
    setScrollHeight(textarea, 40);
    let scheduledCallback: FrameRequestCallback | null = null;
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        scheduledCallback = callback;
        return 1;
      });

    const { result } = renderHook(() =>
      useAutosizeHarness({ textarea, value: "hello", maxHeight: 200 }),
    );

    setScrollHeight(textarea, 120);
    act(() => {
      result.current.scheduleAutosize();
      result.current.scheduleAutosize();
    });

    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(textarea.style.height).toBe("40px");

    act(() => {
      scheduledCallback?.(0);
    });

    expect(textarea.style.height).toBe("120px");
  });

  it("schedules autosize when the textarea width changes", () => {
    const textarea = document.createElement("textarea");
    const resizeObserver = installResizeObserverMock();
    setScrollHeight(textarea, 40);
    let scheduledCallback: FrameRequestCallback | null = null;
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        scheduledCallback = callback;
        return 1;
      });

    renderHook(() =>
      useAutosizeHarness({ textarea, value: "hello", maxHeight: 200 }),
    );

    setScrollHeight(textarea, 120);
    act(() => {
      resizeObserver.emit(320);
      resizeObserver.emit(320);
    });

    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(textarea.style.height).toBe("40px");

    act(() => {
      scheduledCallback?.(0);
    });

    expect(textarea.style.height).toBe("120px");
  });

  it("can reset height without measuring", () => {
    const textarea = document.createElement("textarea");
    setScrollHeight(textarea, 120);

    const { result } = renderHook(() =>
      useAutosizeHarness({ textarea, value: "hello", maxHeight: 80 }),
    );

    expect(textarea.style.height).toBe("80px");

    act(() => {
      result.current.resetHeight();
    });

    expect(textarea.style.height).toBe("auto");
  });
});
