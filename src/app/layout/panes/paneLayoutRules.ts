import type { AppShellPaneId, PaneAnchor, PaneLayoutId } from "./paneTypes";

export type PaneDragThreshold = {
  axis: "x" | "y";
  direction: "positive" | "negative";
  minDeltaPx: number;
  minSurfaceRatio?: number;
};

export type PaneDragRule = {
  sourcePaneId: AppShellPaneId;
  fromLayoutId: PaneLayoutId;
  toLayoutId: PaneLayoutId;
  targetAnchor: PaneAnchor;
  threshold: PaneDragThreshold;
};

export type PaneCombinationRule = {
  sourcePaneId: AppShellPaneId;
  targetPaneId: AppShellPaneId;
  edge: "bottom" | "right";
  layoutId: PaneLayoutId;
};

export const APP_SHELL_PANE_COMBINATION_RULES = [
  {
    sourcePaneId: "chatList",
    targetPaneId: "primaryNav",
    edge: "bottom",
    layoutId: "navigation-panes-combined",
  },
  {
    sourcePaneId: "chatList",
    targetPaneId: "primaryNav",
    edge: "right",
    layoutId: "navigation-panes-split",
  },
] as const satisfies readonly PaneCombinationRule[];

export const APP_SHELL_PANE_DRAG_RULES = [
  {
    sourcePaneId: "chatList",
    fromLayoutId: "navigation-panes-combined",
    toLayoutId: "navigation-panes-split",
    targetAnchor: { kind: "pane", paneId: "primaryNav", edge: "right" },
    threshold: {
      axis: "x",
      direction: "positive",
      minDeltaPx: 96,
      minSurfaceRatio: 0.5,
    },
  },
  {
    sourcePaneId: "chatList",
    fromLayoutId: "navigation-panes-split",
    toLayoutId: "navigation-panes-combined",
    targetAnchor: { kind: "pane", paneId: "primaryNav", edge: "bottom" },
    threshold: {
      axis: "x",
      direction: "negative",
      minDeltaPx: 96,
      minSurfaceRatio: 0.4,
    },
  },
] as const satisfies readonly PaneDragRule[];
