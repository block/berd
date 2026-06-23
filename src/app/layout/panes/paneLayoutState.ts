import type { PaneLayoutState } from "./paneTypes";

export const NAVIGATION_PANES_COMBINED_LAYOUT: PaneLayoutState = {
  id: "navigation-panes-combined",
  groups: [
    {
      id: "navigationPaneStack",
      kind: "stack",
      orientation: "vertical",
      panes: ["primaryNav", "chatList"],
      anchor: { kind: "window", edge: "left" },
      sizeRules: [
        {
          kind: "shared-max",
          axis: "width",
          panes: ["primaryNav", "chatList"],
        },
      ],
    },
    {
      id: "chatView",
      kind: "single",
      paneId: "chatView",
      anchor: { kind: "window", edge: "top" },
    },
    {
      id: "rightRail",
      kind: "single",
      paneId: "rightRail",
      anchor: { kind: "window", edge: "right" },
    },
  ],
  placements: {
    primaryNav: {
      paneId: "primaryNav",
      anchor: { kind: "window", edge: "left" },
      groupId: "navigationPaneStack",
    },
    chatList: {
      paneId: "chatList",
      anchor: { kind: "pane", paneId: "primaryNav", edge: "bottom" },
      groupId: "navigationPaneStack",
    },
    chatView: {
      paneId: "chatView",
      anchor: { kind: "window", edge: "top" },
      groupId: "chatView",
    },
    rightRail: {
      paneId: "rightRail",
      anchor: { kind: "window", edge: "right" },
      groupId: "rightRail",
    },
  },
};

export const NAVIGATION_PANES_SPLIT_LAYOUT: PaneLayoutState = {
  id: "navigation-panes-split",
  groups: [
    {
      id: "primaryNav",
      kind: "single",
      paneId: "primaryNav",
      anchor: { kind: "window", edge: "left" },
    },
    {
      id: "chatList",
      kind: "single",
      paneId: "chatList",
      anchor: { kind: "pane", paneId: "primaryNav", edge: "right" },
    },
    {
      id: "chatView",
      kind: "single",
      paneId: "chatView",
      anchor: { kind: "window", edge: "top" },
    },
    {
      id: "rightRail",
      kind: "single",
      paneId: "rightRail",
      anchor: { kind: "window", edge: "right" },
    },
  ],
  placements: {
    primaryNav: {
      paneId: "primaryNav",
      anchor: { kind: "window", edge: "left" },
      groupId: "primaryNav",
    },
    chatList: {
      paneId: "chatList",
      anchor: { kind: "pane", paneId: "primaryNav", edge: "right" },
      groupId: "chatList",
    },
    chatView: {
      paneId: "chatView",
      anchor: { kind: "window", edge: "top" },
      groupId: "chatView",
    },
    rightRail: {
      paneId: "rightRail",
      anchor: { kind: "window", edge: "right" },
      groupId: "rightRail",
    },
  },
};

export const APP_SHELL_PANE_LAYOUTS = {
  "navigation-panes-combined": NAVIGATION_PANES_COMBINED_LAYOUT,
  "navigation-panes-split": NAVIGATION_PANES_SPLIT_LAYOUT,
} as const;

export const DEFAULT_APP_SHELL_PANE_LAYOUT = NAVIGATION_PANES_COMBINED_LAYOUT;
