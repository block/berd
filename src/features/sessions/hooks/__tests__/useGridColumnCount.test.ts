import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useGridColumnCount } from "../useGridColumnCount";

class MockResizeObserver {
  static callbacks = new Set<ResizeObserverCallback>();

  constructor(callback: ResizeObserverCallback) {
    MockResizeObserver.callbacks.add(callback);
  }

  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();

  static emit() {
    for (const callback of MockResizeObserver.callbacks) {
      callback([], {} as ResizeObserver);
    }
  }
}

function makeGridRef(columns: string) {
  const element = document.createElement("div");
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    gridTemplateColumns: columns,
  } as CSSStyleDeclaration);
  return { current: element };
}

describe("useGridColumnCount", () => {
  afterEach(() => {
    MockResizeObserver.callbacks.clear();
    vi.restoreAllMocks();
  });

  it("counts columns from computed grid template columns", () => {
    const gridRef = makeGridRef("120px 120px 120px");
    vi.stubGlobal("ResizeObserver", MockResizeObserver);

    const { result } = renderHook(() => useGridColumnCount(gridRef));

    expect(result.current).toBe(3);
  });

  it("falls back to one column when there is no grid template", () => {
    const gridRef = makeGridRef("none");
    vi.stubGlobal("ResizeObserver", MockResizeObserver);

    const { result } = renderHook(() => useGridColumnCount(gridRef));

    expect(result.current).toBe(1);
  });

  it("updates when the observed grid resizes", () => {
    const element = document.createElement("div");
    const gridRef = { current: element };
    let columns = "120px";
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      () => ({ gridTemplateColumns: columns }) as CSSStyleDeclaration,
    );
    vi.stubGlobal("ResizeObserver", MockResizeObserver);

    const { result } = renderHook(() => useGridColumnCount(gridRef));
    expect(result.current).toBe(1);

    columns = "120px 120px 120px 120px";
    act(() => MockResizeObserver.emit());

    expect(result.current).toBe(4);
  });
});
