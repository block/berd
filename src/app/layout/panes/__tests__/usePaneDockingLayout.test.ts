import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  SIDEBAR_CHAT_LIST_MAX_WIDTH_PX,
  SIDEBAR_PRIMARY_NAV_COMPACT_WIDTH_PX,
  SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
} from "../paneSizeRules";
import { usePaneDockingLayout } from "../usePaneDockingLayout";

describe("usePaneDockingLayout", () => {
  it("tracks independently resizable sidebar pane widths", () => {
    const { result } = renderHook(() =>
      usePaneDockingLayout({ baseNavigationWidth: 220, enabled: true }),
    );

    expect(result.current.navigationPaneSizes).toEqual({
      primaryNav: 200,
      chatList: 220,
    });

    act(() => {
      result.current.resizeNavigationPane("primaryNav", 120);
      result.current.resizeNavigationPane("chatList", 140);
    });

    expect(result.current.navigationPaneSizes).toEqual({
      primaryNav: SIDEBAR_PRIMARY_NAV_COMPACT_WIDTH_PX,
      chatList: 160,
    });
    expect(result.current.suppressNavigationWidthTransition).toBe(true);

    act(() => {
      result.current.resizeNavigationPane("primaryNav", 150);
    });

    expect(result.current.navigationPaneSizes.primaryNav).toBe(200);
  });

  it("applies the combined stacked sidebar width rule", () => {
    const { result } = renderHook(() =>
      usePaneDockingLayout({ baseNavigationWidth: 220, enabled: true }),
    );

    act(() => {
      result.current.resizeNavigationPane("navigationStack", 120);
    });

    expect(result.current.navigationPaneSizes).toEqual({
      primaryNav: 200,
      chatList: 200,
    });

    act(() => {
      result.current.resizeNavigationPane("navigationStack", 500);
    });

    expect(result.current.navigationPaneSizes).toEqual({
      primaryNav: 420,
      chatList: 420,
    });
  });

  it("restores independent pane width constraints when stacked panes split", async () => {
    const { result } = renderHook(() =>
      usePaneDockingLayout({ baseNavigationWidth: 220, enabled: true }),
    );

    act(() => {
      result.current.resizeNavigationPane("navigationStack", 500);
    });

    expect(result.current.navigationPaneSizes).toEqual({
      primaryNav: SIDEBAR_CHAT_LIST_MAX_WIDTH_PX,
      chatList: SIDEBAR_CHAT_LIST_MAX_WIDTH_PX,
    });

    act(() => {
      result.current.commitPaneDragRelease({
        paneId: "chatList",
        startClientX: 0,
        startClientY: 0,
        currentClientX: 260,
        currentClientY: 0,
        surfaceWidth: SIDEBAR_CHAT_LIST_MAX_WIDTH_PX,
        hasSeparated: true,
      });
    });

    await waitFor(() => {
      expect(result.current.chatListDock).toBe("side");
      expect(result.current.navigationPaneSizes).toEqual({
        primaryNav: SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
        chatList: SIDEBAR_CHAT_LIST_MAX_WIDTH_PX,
      });
    });
  });

  it("combines side-docked panes back into the stacked layout without changing pane sizes", async () => {
    const { result } = renderHook(() =>
      usePaneDockingLayout({ baseNavigationWidth: 220, enabled: true }),
    );

    act(() => {
      result.current.resizeNavigationPane("chatList", 320);
      result.current.commitPaneDragRelease({
        paneId: "chatList",
        startClientX: 0,
        startClientY: 0,
        currentClientX: 180,
        currentClientY: 0,
        surfaceWidth: 220,
        hasSeparated: true,
      });
    });

    await waitFor(() => {
      expect(result.current.chatListDock).toBe("side");
      expect(result.current.navigationPaneSizes).toEqual({
        primaryNav: SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
        chatList: 320,
      });
    });

    act(() => {
      result.current.commitPaneDragRelease({
        paneId: "chatList",
        startClientX: 340,
        startClientY: 0,
        currentClientX: 180,
        currentClientY: 0,
        surfaceWidth: 320,
        hasSeparated: true,
      });
    });

    await waitFor(() => {
      expect(result.current.chatListDock).toBe("stacked");
      expect(result.current.navigationPaneSizes).toEqual({
        primaryNav: SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
        chatList: 320,
      });
    });
  });

  it("resets layout state and pane sizes when the experiment is disabled", async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) =>
        usePaneDockingLayout({ baseNavigationWidth: 220, enabled }),
      {
        initialProps: { enabled: true },
      },
    );

    act(() => {
      result.current.beginNavigationPaneResize();
      result.current.resizeNavigationPane("navigationStack", 500);
      result.current.commitPaneDragRelease({
        paneId: "chatList",
        startClientX: 0,
        startClientY: 0,
        currentClientX: 260,
        currentClientY: 0,
        surfaceWidth: SIDEBAR_CHAT_LIST_MAX_WIDTH_PX,
        hasSeparated: true,
      });
    });

    await waitFor(() => {
      expect(result.current.chatListDock).toBe("side");
      expect(result.current.navigationPaneSizes).toEqual({
        primaryNav: SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
        chatList: SIDEBAR_CHAT_LIST_MAX_WIDTH_PX,
      });
    });

    rerender({ enabled: false });

    await waitFor(() => {
      expect(result.current.chatListDock).toBe("stacked");
      expect(result.current.navigationPaneSizes).toEqual({
        primaryNav: SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
        chatList: 220,
      });
      expect(result.current.suppressNavigationWidthTransition).toBe(false);
    });
  });
});
