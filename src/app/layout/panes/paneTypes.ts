export type AppShellPaneId =
  | "primaryNav"
  | "chatList"
  | "chatView"
  | "rightRail";

export type PaneEdge = "left" | "right" | "top" | "bottom";

export type PaneAnchor =
  | {
      kind: "window";
      edge: PaneEdge;
    }
  | {
      kind: "pane";
      paneId: AppShellPaneId;
      edge: PaneEdge;
    };

export type PaneSizeConstraint =
  | {
      kind: "range";
      minPx: number;
      maxPx: number;
      defaultPx: number;
    }
  | {
      kind: "presets";
      valuesPx: readonly number[];
      defaultPx: number;
    };

export type PaneHeightConstraint =
  | {
      kind: "content";
    }
  | {
      kind: "fill";
    };

export type PaneRegistryEntry = {
  id: AppShellPaneId;
  label: string;
  defaultAnchor: PaneAnchor;
  width: PaneSizeConstraint;
  height: PaneHeightConstraint;
};

export type PaneGroupSizeRule = {
  kind: "shared-max";
  axis: "width";
  panes: readonly AppShellPaneId[];
};

export type PaneGroup =
  | {
      id: string;
      kind: "stack";
      orientation: "vertical" | "horizontal";
      panes: readonly AppShellPaneId[];
      anchor: PaneAnchor;
      sizeRules?: readonly PaneGroupSizeRule[];
    }
  | {
      id: string;
      kind: "single";
      paneId: AppShellPaneId;
      anchor: PaneAnchor;
    };

export type PaneLayoutId =
  | "navigation-panes-combined"
  | "navigation-panes-split";

export type PanePlacement = {
  paneId: AppShellPaneId;
  anchor: PaneAnchor;
  groupId: string;
};

export type PaneLayoutState = {
  id: PaneLayoutId;
  groups: readonly PaneGroup[];
  placements: Record<AppShellPaneId, PanePlacement>;
};

export type ChatListPaneDock = "stacked" | "side";

export type NavigationPaneSizeId = "primaryNav" | "chatList";

export type NavigationResizablePaneId =
  | NavigationPaneSizeId
  | "navigationStack";

export type NavigationPaneSizes = Record<NavigationPaneSizeId, number>;

export type PaneDragReleaseIntent = {
  paneId: AppShellPaneId;
  startClientX: number;
  startClientY: number;
  currentClientX: number;
  currentClientY: number;
  surfaceWidth: number;
  hasSeparated: boolean;
};
