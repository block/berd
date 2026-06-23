import { describe, expect, it } from "vitest";
import {
  getChatListDockFromLayout,
  getDropDockForPaneDrag,
  resolvePaneDragRelease,
} from "../paneLayoutResolver";
import {
  NAVIGATION_PANES_COMBINED_LAYOUT,
  NAVIGATION_PANES_SPLIT_LAYOUT,
} from "../paneLayoutState";
import { APP_SHELL_PANE_REGISTRY } from "../paneRegistry";
import {
  SIDEBAR_CHAT_LIST_MAX_WIDTH_PX,
  SIDEBAR_CHAT_LIST_MIN_WIDTH_PX,
  SIDEBAR_PRIMARY_NAV_COMPACT_WIDTH_PX,
  SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
} from "../paneSizeRules";

describe("paneLayoutResolver", () => {
  it("declares the panes AppShell can compose", () => {
    expect(Object.keys(APP_SHELL_PANE_REGISTRY)).toEqual([
      "primaryNav",
      "chatList",
      "chatView",
      "rightRail",
    ]);
    expect(APP_SHELL_PANE_REGISTRY.primaryNav.defaultAnchor).toEqual({
      kind: "window",
      edge: "left",
    });
    expect(APP_SHELL_PANE_REGISTRY.rightRail.defaultAnchor).toEqual({
      kind: "window",
      edge: "right",
    });
    expect(APP_SHELL_PANE_REGISTRY.primaryNav.width).toEqual({
      kind: "presets",
      valuesPx: [
        SIDEBAR_PRIMARY_NAV_COMPACT_WIDTH_PX,
        SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
      ],
      defaultPx: SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
    });
    expect(APP_SHELL_PANE_REGISTRY.chatList.width).toEqual({
      kind: "range",
      minPx: SIDEBAR_CHAT_LIST_MIN_WIDTH_PX,
      maxPx: SIDEBAR_CHAT_LIST_MAX_WIDTH_PX,
      defaultPx: 200,
    });
  });

  it("declares stacked nav and chat sizing as a shared pane group rule", () => {
    const stackGroup = NAVIGATION_PANES_COMBINED_LAYOUT.groups.find(
      (group) => group.id === "navigationPaneStack",
    );

    expect(stackGroup).toMatchObject({
      kind: "stack",
      orientation: "vertical",
      panes: ["primaryNav", "chatList"],
      sizeRules: [
        {
          kind: "shared-max",
          axis: "width",
          panes: ["primaryNav", "chatList"],
        },
      ],
    });
  });

  it("keeps a pane in place when the drag has not separated", () => {
    const intent = {
      paneId: "chatList",
      startClientX: 20,
      startClientY: 80,
      currentClientX: 180,
      currentClientY: 82,
      surfaceWidth: 200,
      hasSeparated: false,
    } as const;
    const nextLayout = resolvePaneDragRelease(
      NAVIGATION_PANES_COMBINED_LAYOUT,
      intent,
    );

    expect(nextLayout).toBe(NAVIGATION_PANES_COMBINED_LAYOUT);
    expect(getChatListDockFromLayout(nextLayout)).toBe("stacked");
    expect(
      getDropDockForPaneDrag(NAVIGATION_PANES_COMBINED_LAYOUT, intent),
    ).toBe(null);
  });

  it("does not preview a dock before the drag crosses the rule threshold", () => {
    const intent = {
      paneId: "chatList",
      startClientX: 20,
      startClientY: 80,
      currentClientX: 120,
      currentClientY: 82,
      surfaceWidth: 200,
      hasSeparated: true,
    } as const;

    expect(
      resolvePaneDragRelease(NAVIGATION_PANES_COMBINED_LAYOUT, intent),
    ).toBe(NAVIGATION_PANES_COMBINED_LAYOUT);
    expect(
      getDropDockForPaneDrag(NAVIGATION_PANES_COMBINED_LAYOUT, intent),
    ).toBe(null);
  });

  it("anchors the chat list to the nav right edge after a rightward drag", () => {
    const intent = {
      paneId: "chatList",
      startClientX: 20,
      startClientY: 80,
      currentClientX: 121,
      currentClientY: 86,
      surfaceWidth: 200,
      hasSeparated: true,
    } as const;
    const nextLayout = resolvePaneDragRelease(
      NAVIGATION_PANES_COMBINED_LAYOUT,
      intent,
    );

    expect(nextLayout).toBe(NAVIGATION_PANES_SPLIT_LAYOUT);
    expect(nextLayout.placements.chatList.anchor).toEqual({
      kind: "pane",
      paneId: "primaryNav",
      edge: "right",
    });
    expect(getChatListDockFromLayout(nextLayout)).toBe("side");
    expect(
      getDropDockForPaneDrag(NAVIGATION_PANES_COMBINED_LAYOUT, intent),
    ).toBe("side");
  });

  it("combines the chat list below the nav after a leftward drag", () => {
    const intent = {
      paneId: "chatList",
      startClientX: 220,
      startClientY: 80,
      currentClientX: 123,
      currentClientY: 86,
      surfaceWidth: 200,
      hasSeparated: true,
    } as const;
    const nextLayout = resolvePaneDragRelease(
      NAVIGATION_PANES_SPLIT_LAYOUT,
      intent,
    );

    expect(nextLayout).toBe(NAVIGATION_PANES_COMBINED_LAYOUT);
    expect(nextLayout.placements.chatList.anchor).toEqual({
      kind: "pane",
      paneId: "primaryNav",
      edge: "bottom",
    });
    expect(getChatListDockFromLayout(nextLayout)).toBe("stacked");
    expect(getDropDockForPaneDrag(NAVIGATION_PANES_SPLIT_LAYOUT, intent)).toBe(
      "stacked",
    );
  });
});
