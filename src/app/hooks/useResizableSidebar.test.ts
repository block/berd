import { act, renderHook, waitFor } from "@testing-library/react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useResizableSidebar } from "./useResizableSidebar";

type ResizableSidebar = ReturnType<typeof useResizableSidebar>;
let restoreLocalStorageSetItem: (() => void) | null = null;

function setWindowWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

function setWindowHeight(height: number) {
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: height,
  });
}

function dragSidebar(
  sidebar: ResizableSidebar,
  axis: "width" | "height" | "both",
  { clientX = 60, clientY = 80 } = {},
) {
  const start =
    axis === "both"
      ? sidebar.handleCornerResizeStart
      : axis === "height"
        ? sidebar.handleHeightResizeStart
        : sidebar.handleResizeStart;

  act(() => {
    start({
      clientX: 0,
      clientY: 0,
      preventDefault: vi.fn(),
    } as unknown as ReactMouseEvent);
  });
  act(() => {
    document.dispatchEvent(new MouseEvent("mousemove", { clientX, clientY }));
    document.dispatchEvent(new MouseEvent("mouseup"));
  });
}

describe("useResizableSidebar", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setWindowWidth(1024);
    setWindowHeight(768);
    document.documentElement.style.removeProperty("--spacing-app-top-bar");
    document.documentElement.style.removeProperty(
      "--spacing-app-panel-gutter-bottom",
    );
  });

  afterEach(() => {
    restoreLocalStorageSetItem?.();
    restoreLocalStorageSetItem = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts expanded at the default width", () => {
    const { result } = renderHook(() => useResizableSidebar());

    expect(result.current.isCollapsed).toBe(false);
    expect(result.current.sidebarCollapsed).toBe(false);
    expect(result.current.sidebarWidth).toBe(200);
    expect(result.current.sidebarOuterWidth).toBeGreaterThan(
      result.current.sidebarWidth,
    );
    expect(result.current.sidebarHeight).toBe(528);
    expect(result.current.sidebarOuterHeight).toBe(
      result.current.sidebarHeight,
    );
  });

  it("starts collapsed when the minimum sidebar width does not fit", () => {
    setWindowWidth(740);

    const { result } = renderHook(() => useResizableSidebar());

    expect(result.current.isCollapsed).toBe(true);
    expect(result.current.sidebarOuterWidth).toBe(0);
  });

  it("exposes a fully-collapsed state when toggled closed", () => {
    const { result } = renderHook(() => useResizableSidebar());

    act(() => {
      result.current.toggleCollapse();
    });

    expect(result.current.isCollapsed).toBe(true);
    expect(result.current.sidebarCollapsed).toBe(true);
  });

  it("restores the previous width when toggled open", async () => {
    const { result } = renderHook(() => useResizableSidebar());
    const initialWidth = result.current.sidebarWidth;

    act(() => {
      result.current.toggleCollapse();
    });
    act(() => {
      result.current.toggleCollapse();
    });

    await waitFor(() => {
      expect(result.current.isCollapsed).toBe(false);
    });
    expect(result.current.sidebarWidth).toBe(initialWidth);
  });

  it("keeps a resized width across collapse and expand", async () => {
    const { result } = renderHook(() => useResizableSidebar());
    const initialWidth = result.current.sidebarWidth;

    dragSidebar(result.current, "width");

    const resizedWidth = result.current.sidebarWidth;
    expect(resizedWidth).toBeGreaterThan(initialWidth);

    act(() => {
      result.current.toggleCollapse();
    });
    act(() => {
      result.current.toggleCollapse();
    });

    await waitFor(() => {
      expect(result.current.isCollapsed).toBe(false);
    });
    expect(result.current.sidebarWidth).toBe(resizedWidth);
  });

  it("resizes height from the bottom edge", () => {
    const { result } = renderHook(() => useResizableSidebar());
    const initialHeight = result.current.sidebarHeight;

    dragSidebar(result.current, "height");

    expect(result.current.sidebarHeight).toBeGreaterThan(initialHeight);
  });

  it("resizes width and height from the bottom-right corner", () => {
    const { result } = renderHook(() => useResizableSidebar());
    const initialWidth = result.current.sidebarWidth;
    const initialHeight = result.current.sidebarHeight;

    dragSidebar(result.current, "both");

    expect(result.current.sidebarWidth).toBeGreaterThan(initialWidth);
    expect(result.current.sidebarHeight).toBeGreaterThan(initialHeight);
  });

  it("keeps a full-height sidebar attached to the viewport bottom", () => {
    const { result } = renderHook(() => useResizableSidebar());

    dragSidebar(result.current, "height", { clientY: 1000 });
    expect(result.current.sidebarHeight).toBe(704);

    act(() => {
      setWindowHeight(900);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.sidebarHeight).toBe(836);

    act(() => {
      setWindowHeight(700);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.sidebarHeight).toBe(636);
  });

  it("restores full-height behavior after remount", () => {
    const { result, unmount } = renderHook(() => useResizableSidebar());

    dragSidebar(result.current, "height", { clientY: 1000 });
    unmount();

    setWindowHeight(900);
    const { result: remountedResult } = renderHook(() => useResizableSidebar());
    expect(remountedResult.current.sidebarHeight).toBe(836);
  });

  it("keeps a fixed preferred height when the viewport temporarily clamps it", () => {
    setWindowHeight(900);
    const { result } = renderHook(() => useResizableSidebar());

    dragSidebar(result.current, "height", { clientY: 100 });
    expect(result.current.sidebarHeight).toBe(727);

    act(() => {
      setWindowHeight(700);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.sidebarHeight).toBe(636);

    act(() => {
      setWindowHeight(900);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.sidebarHeight).toBe(727);
  });

  it("preserves a clamped fixed height during a width-only corner drag", () => {
    window.localStorage.setItem(
      "goose:sidebar:layout",
      JSON.stringify({
        width: 240,
        height: 727,
        heightMode: "fixed",
      }),
    );
    setWindowHeight(700);
    const { result } = renderHook(() => useResizableSidebar());
    expect(result.current.sidebarHeight).toBe(636);

    dragSidebar(result.current, "both", { clientX: 60, clientY: 0 });

    act(() => {
      setWindowHeight(900);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.sidebarHeight).toBe(727);
  });

  it("restores the starting height when a corner drag returns to its start Y", () => {
    const { result } = renderHook(() => useResizableSidebar());
    const initialHeight = result.current.sidebarHeight;

    act(() => {
      result.current.handleCornerResizeStart({
        clientX: 0,
        clientY: 0,
        preventDefault: vi.fn(),
      } as unknown as ReactMouseEvent);
    });
    act(() => {
      document.dispatchEvent(
        new MouseEvent("mousemove", { clientX: 60, clientY: 80 }),
      );
      document.dispatchEvent(
        new MouseEvent("mousemove", { clientX: 60, clientY: 0 }),
      );
      document.dispatchEvent(new MouseEvent("mouseup"));
    });

    expect(result.current.sidebarHeight).toBe(initialHeight);
  });

  it("returns a full-height sidebar to fixed height after dragging upward", () => {
    const { result } = renderHook(() => useResizableSidebar());

    dragSidebar(result.current, "height", { clientY: 1000 });
    dragSidebar(result.current, "height", { clientY: -100 });
    expect(result.current.sidebarHeight).toBe(604);

    act(() => {
      setWindowHeight(900);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.sidebarHeight).toBe(604);
  });

  it("restores resized dimensions after remount", () => {
    const { result, unmount } = renderHook(() => useResizableSidebar());
    const initialWidth = result.current.sidebarWidth;
    const initialHeight = result.current.sidebarHeight;

    dragSidebar(result.current, "both");

    const resizedWidth = result.current.sidebarWidth;
    const resizedHeight = result.current.sidebarHeight;
    expect(resizedWidth).toBeGreaterThan(initialWidth);
    expect(resizedHeight).toBeGreaterThan(initialHeight);

    unmount();
    const { result: remountedResult } = renderHook(() => useResizableSidebar());

    expect(remountedResult.current.sidebarWidth).toBe(resizedWidth);
    expect(remountedResult.current.sidebarHeight).toBe(resizedHeight);
  });

  it("does not restore a collapsed sidebar after remount", () => {
    const { result, unmount } = renderHook(() => useResizableSidebar());

    act(() => {
      result.current.toggleCollapse();
    });

    expect(result.current.isCollapsed).toBe(true);

    unmount();
    const { result: remountedResult } = renderHook(() => useResizableSidebar());

    expect(remountedResult.current.isCollapsed).toBe(false);
    expect(remountedResult.current.sidebarOuterWidth).toBeGreaterThan(0);
  });

  it("falls back to defaults for invalid stored layout data", () => {
    const { result: defaultResult, unmount } = renderHook(() =>
      useResizableSidebar(),
    );
    const defaultWidth = defaultResult.current.sidebarWidth;
    const defaultHeight = defaultResult.current.sidebarHeight;
    unmount();
    window.localStorage.clear();
    window.localStorage.setItem(
      "goose:sidebar:layout",
      JSON.stringify({
        width: "wide",
        height: Number.POSITIVE_INFINITY,
        heightMode: "tall",
        heightCustomized: "yes",
      }),
    );

    const { result } = renderHook(() => useResizableSidebar());

    expect(result.current.sidebarWidth).toBe(defaultWidth);
    expect(result.current.sidebarHeight).toBe(defaultHeight);
  });

  it("migrates a legacy customized height to fixed height", () => {
    window.localStorage.setItem(
      "goose:sidebar:layout",
      JSON.stringify({
        width: 240,
        height: 640,
        heightCustomized: true,
      }),
    );
    const { result } = renderHook(() => useResizableSidebar());

    expect(result.current.sidebarHeight).toBe(640);

    act(() => {
      setWindowHeight(900);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.sidebarHeight).toBe(640);
  });

  it("shrinks a wide sidebar before collapsing on narrow windows", () => {
    window.localStorage.setItem(
      "goose:sidebar:layout",
      JSON.stringify({
        width: 420,
        height: 400,
        heightCustomized: true,
      }),
    );
    setWindowWidth(800);

    const { result } = renderHook(() => useResizableSidebar());

    expect(result.current.isCollapsed).toBe(false);
    expect(result.current.sidebarWidth).toBe(240);
  });

  it("keeps the collapsed panel width clamped on narrow windows", () => {
    window.localStorage.setItem(
      "goose:sidebar:layout",
      JSON.stringify({
        width: 420,
        height: 400,
        heightCustomized: true,
      }),
    );
    setWindowWidth(800);

    const { result } = renderHook(() => useResizableSidebar());
    const expandedPanelOuterWidth = result.current.sidebarPanelOuterWidth;

    expect(result.current.sidebarWidth).toBe(240);
    expect(expandedPanelOuterWidth).toBe(252);

    act(() => {
      result.current.toggleCollapse();
    });

    expect(result.current.isCollapsed).toBe(true);
    expect(result.current.sidebarOuterWidth).toBe(0);
    expect(result.current.sidebarPanelOuterWidth).toBe(expandedPanelOuterWidth);
  });

  it("restores the preferred sidebar width when space returns", async () => {
    window.localStorage.setItem(
      "goose:sidebar:layout",
      JSON.stringify({
        width: 420,
        height: 400,
        heightCustomized: true,
      }),
    );
    setWindowWidth(800);
    const { result } = renderHook(() => useResizableSidebar());

    expect(result.current.sidebarWidth).toBe(240);

    act(() => {
      setWindowWidth(1024);
      window.dispatchEvent(new Event("resize"));
    });

    await waitFor(() => {
      expect(result.current.sidebarWidth).toBe(420);
    });
  });

  it("collapses only after the minimum sidebar width no longer fits", async () => {
    window.localStorage.setItem(
      "goose:sidebar:layout",
      JSON.stringify({
        width: 420,
        height: 400,
        heightCustomized: true,
      }),
    );
    setWindowWidth(740);

    const { result } = renderHook(() => useResizableSidebar());

    await waitFor(() => {
      expect(result.current.isCollapsed).toBe(true);
    });
  });

  it("reopens when a viewport-forced collapse has room again", async () => {
    setWindowWidth(740);
    const { result } = renderHook(() => useResizableSidebar());

    await waitFor(() => {
      expect(result.current.isCollapsed).toBe(true);
    });

    act(() => {
      setWindowWidth(1024);
      window.dispatchEvent(new Event("resize"));
    });

    await waitFor(() => {
      expect(result.current.isCollapsed).toBe(false);
    });
    expect(result.current.sidebarOuterWidth).toBeGreaterThan(0);
  });

  it("keeps a manually collapsed sidebar closed when the window widens", async () => {
    const { result } = renderHook(() => useResizableSidebar());

    act(() => {
      result.current.toggleCollapse();
    });

    expect(result.current.isCollapsed).toBe(true);

    act(() => {
      setWindowWidth(740);
      window.dispatchEvent(new Event("resize"));
    });

    await waitFor(() => {
      expect(result.current.isCollapsed).toBe(true);
    });

    act(() => {
      setWindowWidth(1024);
      window.dispatchEvent(new Event("resize"));
    });

    await waitFor(() => {
      expect(result.current.isCollapsed).toBe(true);
    });
  });

  it("treats OS window resize as transient resizing state", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useResizableSidebar());

    act(() => {
      setWindowWidth(900);
      window.dispatchEvent(new Event("resize"));
    });

    expect(result.current.isResizing).toBe(true);

    act(() => {
      vi.advanceTimersByTime(119);
    });
    expect(result.current.isResizing).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.isResizing).toBe(false);
  });

  it("does not persist height layout again during width-only window resize", async () => {
    const originalSetItem = window.localStorage.setItem.bind(
      window.localStorage,
    );
    const setItemSpy = vi.fn(originalSetItem);
    Object.defineProperty(window.localStorage, "setItem", {
      configurable: true,
      value: setItemSpy,
    });
    restoreLocalStorageSetItem = () => {
      Object.defineProperty(window.localStorage, "setItem", {
        configurable: true,
        value: originalSetItem,
      });
    };
    const { result } = renderHook(() => useResizableSidebar());
    const initialHeight = result.current.sidebarHeight;

    await waitFor(() =>
      expect(result.current.sidebarHeight).toBeGreaterThan(0),
    );
    setItemSpy.mockClear();

    act(() => {
      setWindowWidth(900);
      window.dispatchEvent(new Event("resize"));
    });

    expect(result.current.sidebarHeight).toBe(initialHeight);
    expect(setItemSpy).not.toHaveBeenCalledWith(
      "goose:sidebar:layout",
      expect.any(String),
    );
  });

  it("returns to the responsive default height on double-click", () => {
    const { result } = renderHook(() => useResizableSidebar());

    dragSidebar(result.current, "height", { clientY: 1000 });
    expect(result.current.sidebarHeight).toBe(704);

    act(() => {
      result.current.handleHeightResizeDoubleClick();
    });
    expect(result.current.sidebarHeight).toBe(528);

    act(() => {
      setWindowHeight(900);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.sidebarHeight).toBe(627);
  });

  it("uses app chrome tokens for the maximum sidebar height", () => {
    setWindowHeight(900);
    document.documentElement.style.setProperty("--spacing-app-top-bar", "52px");
    document.documentElement.style.setProperty(
      "--spacing-app-panel-gutter-bottom",
      "12px",
    );
    const { result } = renderHook(() => useResizableSidebar());

    act(() => {
      result.current.handleHeightResizeStart({
        clientX: 0,
        clientY: 0,
        preventDefault: vi.fn(),
      } as unknown as ReactMouseEvent);
    });
    act(() => {
      document.dispatchEvent(
        new MouseEvent("mousemove", { clientX: 0, clientY: 1000 }),
      );
      document.dispatchEvent(new MouseEvent("mouseup"));
    });

    expect(result.current.sidebarHeight).toBe(836);
  });
});
