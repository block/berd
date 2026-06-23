import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_APP_SHELL_PANE_LAYOUT,
  NAVIGATION_PANES_COMBINED_LAYOUT,
} from "./paneLayoutState";
import {
  getChatListDockFromLayout,
  getDropDockForPaneDrag,
  resolvePaneDragRelease,
} from "./paneLayoutResolver";
import {
  getDefaultNavigationPaneSizes,
  resolveIndependentNavigationPaneSizes,
  resolveNavigationPaneResizeSurfaceSizes,
} from "./paneSizeRules";
import type {
  PaneDragReleaseIntent,
  PaneLayoutState,
  NavigationPaneSizes,
  NavigationResizablePaneId,
} from "./paneTypes";

export function usePaneDockingLayout({
  baseNavigationWidth,
  enabled,
}: {
  baseNavigationWidth: number;
  enabled: boolean;
}) {
  const [layout, setLayout] = useState<PaneLayoutState>(
    DEFAULT_APP_SHELL_PANE_LAYOUT,
  );
  const [navigationPaneSizes, setNavigationPaneSizes] =
    useState<NavigationPaneSizes>(() =>
      getDefaultNavigationPaneSizes(baseNavigationWidth),
    );
  const [isResizingNavigationPane, setIsResizingNavigationPane] =
    useState(false);
  const [
    suppressNavigationWidthTransition,
    setSuppressNavigationWidthTransition,
  ] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setLayout(NAVIGATION_PANES_COMBINED_LAYOUT);
      setNavigationPaneSizes(
        getDefaultNavigationPaneSizes(baseNavigationWidth),
      );
      setIsResizingNavigationPane(false);
      setSuppressNavigationWidthTransition(false);
    }
  }, [baseNavigationWidth, enabled]);

  useEffect(() => {
    if (!suppressNavigationWidthTransition) return;

    let secondFrame: number | null = null;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        setSuppressNavigationWidthTransition(false);
      });
    });

    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) {
        cancelAnimationFrame(secondFrame);
      }
    };
  }, [suppressNavigationWidthTransition]);

  const effectiveLayout = enabled ? layout : NAVIGATION_PANES_COMBINED_LAYOUT;

  useEffect(() => {
    if (!enabled || getChatListDockFromLayout(effectiveLayout) !== "side") {
      return;
    }

    setNavigationPaneSizes(resolveIndependentNavigationPaneSizes);
  }, [effectiveLayout, enabled]);

  const commitPaneDragRelease = useCallback(
    (intent: PaneDragReleaseIntent) => {
      if (!enabled) return;
      if (intent.hasSeparated) {
        setSuppressNavigationWidthTransition(true);
      }
      setLayout((currentLayout) =>
        resolvePaneDragRelease(currentLayout, intent),
      );
    },
    [enabled],
  );

  const beginNavigationPaneResize = useCallback(() => {
    if (!enabled) return;
    setIsResizingNavigationPane(true);
    setSuppressNavigationWidthTransition(true);
  }, [enabled]);

  const resizeNavigationPane = useCallback(
    (paneId: NavigationResizablePaneId, nextWidth: number) => {
      if (!enabled) return;
      setSuppressNavigationWidthTransition(true);
      setNavigationPaneSizes((currentSizes) =>
        resolveNavigationPaneResizeSurfaceSizes(
          paneId,
          nextWidth,
          currentSizes,
        ),
      );
    },
    [enabled],
  );

  const endNavigationPaneResize = useCallback(() => {
    setIsResizingNavigationPane(false);
  }, []);

  const getPaneDragPreviewDock = useCallback(
    (intent: PaneDragReleaseIntent) =>
      getDropDockForPaneDrag(effectiveLayout, intent),
    [effectiveLayout],
  );

  return useMemo(
    () => ({
      layout: effectiveLayout,
      chatListDock: getChatListDockFromLayout(effectiveLayout),
      navigationPaneSizes,
      beginNavigationPaneResize,
      commitPaneDragRelease,
      endNavigationPaneResize,
      getPaneDragPreviewDock,
      resizeNavigationPane,
      suppressNavigationWidthTransition:
        suppressNavigationWidthTransition || isResizingNavigationPane,
    }),
    [
      beginNavigationPaneResize,
      commitPaneDragRelease,
      effectiveLayout,
      endNavigationPaneResize,
      getPaneDragPreviewDock,
      isResizingNavigationPane,
      resizeNavigationPane,
      navigationPaneSizes,
      suppressNavigationWidthTransition,
    ],
  );
}
