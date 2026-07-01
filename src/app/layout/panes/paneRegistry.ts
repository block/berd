import type { AppShellPaneId, PaneRegistryEntry } from "./paneTypes";

// Keep the icon x-position stable when the primary nav collapses:
// panel inset px-2.5 (10px) + row px-3 (12px) + icon (16px) + matching right
// padding = 60px.
export const SIDEBAR_PRIMARY_NAV_COMPACT_WIDTH_PX = 60;
export const SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX = 200;
export const SIDEBAR_CHAT_LIST_MIN_WIDTH_PX = 160;
export const SIDEBAR_CHAT_LIST_MAX_WIDTH_PX = 420;

export const APP_SHELL_PANE_REGISTRY = {
  primaryNav: {
    id: "primaryNav",
    label: "Primary navigation",
    defaultAnchor: { kind: "window", edge: "left" },
    width: {
      kind: "presets",
      valuesPx: [
        SIDEBAR_PRIMARY_NAV_COMPACT_WIDTH_PX,
        SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
      ],
      defaultPx: SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
    },
    height: { kind: "fill" },
  },
  chatList: {
    id: "chatList",
    label: "Projects and chats",
    defaultAnchor: { kind: "pane", paneId: "primaryNav", edge: "bottom" },
    width: {
      kind: "range",
      minPx: SIDEBAR_CHAT_LIST_MIN_WIDTH_PX,
      maxPx: SIDEBAR_CHAT_LIST_MAX_WIDTH_PX,
      defaultPx: 200,
    },
    height: { kind: "fill" },
  },
  chatView: {
    id: "chatView",
    label: "Chat view",
    defaultAnchor: { kind: "window", edge: "top" },
    width: {
      kind: "range",
      minPx: 532,
      maxPx: 4096,
      defaultPx: 532,
    },
    height: { kind: "fill" },
  },
  rightRail: {
    id: "rightRail",
    label: "Right rail",
    defaultAnchor: { kind: "window", edge: "right" },
    width: {
      kind: "range",
      minPx: 250,
      maxPx: 1024,
      defaultPx: 250,
    },
    height: { kind: "fill" },
  },
} as const satisfies Record<AppShellPaneId, PaneRegistryEntry>;
