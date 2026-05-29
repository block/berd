import { act, renderHook, waitFor } from "@testing-library/react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useResizableSidebar } from "./useResizableSidebar";

type ResizableSidebar = ReturnType<typeof useResizableSidebar>;

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
    document.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 60, clientY: 80 }),
    );
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

  it("starts expanded at the default width", () => {
    const { result } = renderHook(() => useResizableSidebar());

    expect(result.current.isCollapsed).toBe(false);
    expect(result.current.sidebarCollapsed).toBe(false);
    expect(result.current.sidebarWidth).toBeGreaterThan(0);
    expect(result.current.sidebarOuterWidth).toBeGreaterThan(
      result.current.sidebarWidth,
    );
    expect(result.current.sidebarHeight).toBeGreaterThan(0);
    expect(result.current.sidebarOuterHeight).toBe(
      result.current.sidebarHeight,
    );
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
        heightCustomized: "yes",
      }),
    );

    const { result } = renderHook(() => useResizableSidebar());

    expect(result.current.sidebarWidth).toBe(defaultWidth);
    expect(result.current.sidebarHeight).toBe(defaultHeight);
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
