import { describe, expect, it } from "vitest";
import { NAVIGATION_PANES_COMBINED_LAYOUT } from "../paneLayoutState";
import {
  getPaneGroupSharedWidthBounds,
  resolveIndependentNavigationPaneSizes,
  resolvePaneGroupSharedWidth,
  resolvePaneWidth,
  resolveSideBySideNavigationPaneSizesForAvailableWidth,
  resolveStackedNavigationPaneSizes,
  SIDEBAR_CHAT_LIST_MAX_WIDTH_PX,
  SIDEBAR_CHAT_LIST_MIN_WIDTH_PX,
  SIDEBAR_PRIMARY_NAV_COMPACT_WIDTH_PX,
  SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
} from "../paneSizeRules";

describe("paneSizeRules", () => {
  it("snaps preset pane widths to the nearest declared preset", () => {
    expect(resolvePaneWidth("primaryNav", 120)).toBe(
      SIDEBAR_PRIMARY_NAV_COMPACT_WIDTH_PX,
    );
    expect(resolvePaneWidth("primaryNav", 130)).toBe(
      SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
    );
    expect(resolvePaneWidth("primaryNav", 180)).toBe(
      SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
    );
  });

  it("clamps range pane widths to the declared bounds", () => {
    expect(resolvePaneWidth("chatList", 120)).toBe(
      SIDEBAR_CHAT_LIST_MIN_WIDTH_PX,
    );
    expect(resolvePaneWidth("chatList", 260)).toBe(260);
    expect(resolvePaneWidth("chatList", 500)).toBe(
      SIDEBAR_CHAT_LIST_MAX_WIDTH_PX,
    );
  });

  it("resolves stacked pane width from the declared shared group rule", () => {
    expect(
      getPaneGroupSharedWidthBounds(
        NAVIGATION_PANES_COMBINED_LAYOUT,
        "navigationPaneStack",
      ),
    ).toEqual({
      minPx: SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
      maxPx: SIDEBAR_CHAT_LIST_MAX_WIDTH_PX,
    });
    expect(
      resolvePaneGroupSharedWidth(
        NAVIGATION_PANES_COMBINED_LAYOUT,
        "navigationPaneStack",
        120,
      ),
    ).toBe(SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX);
    expect(resolveStackedNavigationPaneSizes(500)).toEqual({
      primaryNav: SIDEBAR_CHAT_LIST_MAX_WIDTH_PX,
      chatList: SIDEBAR_CHAT_LIST_MAX_WIDTH_PX,
    });
  });

  it("keeps side-docked pane widths independent", () => {
    expect(
      resolveIndependentNavigationPaneSizes({
        primaryNav: SIDEBAR_CHAT_LIST_MAX_WIDTH_PX,
        chatList: 260,
      }),
    ).toEqual({
      primaryNav: SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
      chatList: 260,
    });
  });

  it("fits side-docked pane widths within the available shell width", () => {
    expect(
      resolveSideBySideNavigationPaneSizesForAvailableWidth(
        {
          primaryNav: SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
          chatList: SIDEBAR_CHAT_LIST_MAX_WIDTH_PX,
        },
        240,
        10,
      ),
    ).toEqual({
      primaryNav: SIDEBAR_PRIMARY_NAV_COMPACT_WIDTH_PX,
      chatList: 170,
    });
  });
});
