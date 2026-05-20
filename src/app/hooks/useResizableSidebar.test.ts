import { act, renderHook, waitFor } from "@testing-library/react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { useResizableSidebar } from "./useResizableSidebar";

describe("useResizableSidebar", () => {
  it("starts expanded at the default width", () => {
    const { result } = renderHook(() => useResizableSidebar());

    expect(result.current.isCollapsed).toBe(false);
    expect(result.current.sidebarCollapsed).toBe(false);
    expect(result.current.sidebarWidth).toBeGreaterThan(0);
    expect(result.current.sidebarOuterWidth).toBeGreaterThan(
      result.current.sidebarWidth,
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

    act(() => {
      result.current.handleResizeStart({
        clientX: 0,
        preventDefault: vi.fn(),
      } as unknown as ReactMouseEvent);
    });
    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 60 }));
      document.dispatchEvent(new MouseEvent("mouseup"));
    });

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
});
