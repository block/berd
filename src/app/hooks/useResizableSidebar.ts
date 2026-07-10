import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { usePersistedState } from "@/shared/hooks/usePersistedState";

const SIDEBAR_OUTER_GUTTER_WIDTH = 12;
const SIDEBAR_RESIZE_HANDLE_WIDTH = 20;
const SIDEBAR_RESIZE_HANDLE_HEIGHT = 20;
const SIDEBAR_LAYOUT_STORAGE_KEY = "goose:sidebar:layout";
const SIDEBAR_DEFAULT_WIDTH = 200;
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_DEFAULT_HEIGHT_RATIO = 2 / 3;
const SIDEBAR_MIN_HEIGHT = 320;
const SIDEBAR_SNAP_COLLAPSE_THRESHOLD = 100;
const APP_SHELL_PANEL_GUTTER_BOTTOM_FALLBACK = 12;
const APP_SHELL_TOP_BAR_HEIGHT_FALLBACK = 52;
const APP_SHELL_HORIZONTAL_CHROME_WIDTH = 28;
const MIN_MAIN_CONTENT_WIDTH = 532;
const MIN_WINDOW_HEIGHT = 600;
const COLLAPSED_WINDOW_MIN_WIDTH =
  APP_SHELL_HORIZONTAL_CHROME_WIDTH + MIN_MAIN_CONTENT_WIDTH;
const WINDOW_RESIZE_SETTLE_MS = 120;

type SidebarLayoutPreference = {
  width: number;
  height: number;
  heightCustomized: boolean;
};

type SidebarCollapseReason = "manual" | "viewport";

type SidebarCollapseState = {
  collapsed: boolean;
  reason: SidebarCollapseReason | null;
};

function getExpandedSidebarFitWidth(sidebarWidth: number) {
  return (
    sidebarWidth + APP_SHELL_HORIZONTAL_CHROME_WIDTH + MIN_MAIN_CONTENT_WIDTH
  );
}

function getViewportWidth() {
  return typeof window === "undefined"
    ? getExpandedSidebarFitWidth(SIDEBAR_DEFAULT_WIDTH)
    : window.innerWidth;
}

function getMaxSidebarWidthForViewport(viewportWidth: number) {
  return (
    viewportWidth - APP_SHELL_HORIZONTAL_CHROME_WIDTH - MIN_MAIN_CONTENT_WIDTH
  );
}

export function getResponsiveSidebarWidth(
  preferredWidth: number,
  viewportWidth: number,
) {
  const maxVisibleWidth = getMaxSidebarWidthForViewport(viewportWidth);
  if (maxVisibleWidth < SIDEBAR_MIN_WIDTH) {
    return preferredWidth;
  }
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(preferredWidth, maxVisibleWidth));
}

function getAppPanelGutterBottom() {
  if (typeof window === "undefined") {
    return APP_SHELL_PANEL_GUTTER_BOTTOM_FALLBACK;
  }

  const gutter = Number.parseFloat(
    window
      .getComputedStyle(document.documentElement)
      .getPropertyValue("--spacing-app-panel-gutter-bottom"),
  );

  return Number.isFinite(gutter)
    ? gutter
    : APP_SHELL_PANEL_GUTTER_BOTTOM_FALLBACK;
}

function getAppTopBarHeight() {
  if (typeof window === "undefined") {
    return APP_SHELL_TOP_BAR_HEIGHT_FALLBACK;
  }

  const topBarHeight = Number.parseFloat(
    window
      .getComputedStyle(document.documentElement)
      .getPropertyValue("--spacing-app-top-bar"),
  );

  return Number.isFinite(topBarHeight)
    ? topBarHeight
    : APP_SHELL_TOP_BAR_HEIGHT_FALLBACK;
}

function getSidebarFrameHeight() {
  if (typeof window === "undefined") {
    return (
      MIN_WINDOW_HEIGHT -
      APP_SHELL_TOP_BAR_HEIGHT_FALLBACK -
      APP_SHELL_PANEL_GUTTER_BOTTOM_FALLBACK
    );
  }

  return Math.max(
    SIDEBAR_MIN_HEIGHT,
    window.innerHeight - getAppTopBarHeight() - getAppPanelGutterBottom(),
  );
}

function getDefaultSidebarHeight() {
  return Math.round(getSidebarFrameHeight() * SIDEBAR_DEFAULT_HEIGHT_RATIO);
}

function clampSidebarHeight(height: number) {
  return Math.min(
    getSidebarFrameHeight(),
    Math.max(SIDEBAR_MIN_HEIGHT, height),
  );
}

function clampSidebarWidth(width: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

function getDefaultSidebarLayout(): SidebarLayoutPreference {
  return {
    width: SIDEBAR_DEFAULT_WIDTH,
    height: getDefaultSidebarHeight(),
    heightCustomized: false,
  };
}

function getInitialSidebarLayout(): SidebarLayoutPreference {
  const defaults = getDefaultSidebarLayout();
  if (typeof window === "undefined") return defaults;

  try {
    const stored = window.localStorage.getItem(SIDEBAR_LAYOUT_STORAGE_KEY);
    if (!stored) return defaults;
    return validateSidebarLayoutPreference(JSON.parse(stored), defaults);
  } catch {
    return defaults;
  }
}

function shouldCollapseSidebarForViewport(viewportWidth: number) {
  return getMaxSidebarWidthForViewport(viewportWidth) < SIDEBAR_MIN_WIDTH;
}

function getFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function validateSidebarLayoutPreference(
  value: unknown,
  defaults: SidebarLayoutPreference,
): SidebarLayoutPreference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults;
  }

  const layout = value as Record<string, unknown>;
  const width = getFiniteNumber(layout.width);
  const height = getFiniteNumber(layout.height);

  return {
    width: width === null ? defaults.width : clampSidebarWidth(width),
    height: height === null ? defaults.height : clampSidebarHeight(height),
    heightCustomized:
      typeof layout.heightCustomized === "boolean"
        ? layout.heightCustomized
        : defaults.heightCustomized,
  };
}

async function ensureWindowWidth(minWidth: number) {
  if (!window.__TAURI_INTERNALS__ || window.innerWidth >= minWidth) {
    return;
  }

  const { getCurrentWindow, LogicalSize } = await import(
    "@tauri-apps/api/window"
  );
  await getCurrentWindow().setSize(
    new LogicalSize(minWidth, window.innerHeight),
  );
}

async function syncWindowMinimumSize() {
  if (!window.__TAURI_INTERNALS__) {
    return;
  }

  const { getCurrentWindow, LogicalSize } = await import(
    "@tauri-apps/api/window"
  );
  await getCurrentWindow().setMinSize(
    new LogicalSize(COLLAPSED_WINDOW_MIN_WIDTH, MIN_WINDOW_HEIGHT),
  );
}

export function useResizableSidebar() {
  const [initialSidebarLayout] = useState(getInitialSidebarLayout);
  const [sidebarCollapseState, setSidebarCollapseState] =
    useState<SidebarCollapseState>(() => {
      const collapsed = shouldCollapseSidebarForViewport(getViewportWidth());
      return { collapsed, reason: collapsed ? "viewport" : null };
    });
  const [viewportWidth, setViewportWidth] = useState(getViewportWidth);
  const [sidebarLayout, setSidebarLayout] = usePersistedState(
    SIDEBAR_LAYOUT_STORAGE_KEY,
    initialSidebarLayout,
    validateSidebarLayoutPreference,
  );
  const [isResizing, setIsResizing] = useState(false);
  const [isWindowResizing, setIsWindowResizing] = useState(false);
  const windowResizeSettleTimerRef = useRef<number | null>(null);
  const preferredSidebarWidth = sidebarLayout.width;
  const sidebarWidth = getResponsiveSidebarWidth(
    preferredSidebarWidth,
    viewportWidth,
  );
  const sidebarHeight = sidebarLayout.height;
  const sidebarCollapsed = sidebarCollapseState.collapsed;
  const patchSidebarLayout = useCallback(
    (patch: Partial<SidebarLayoutPreference>) => {
      setSidebarLayout((layout) => {
        const entries = Object.entries(patch) as [
          keyof SidebarLayoutPreference,
          SidebarLayoutPreference[keyof SidebarLayoutPreference],
        ][];

        if (entries.every(([key, value]) => layout[key] === value)) {
          return layout;
        }

        return { ...layout, ...patch };
      });
    },
    [setSidebarLayout],
  );

  const sidebarPanelOuterWidth = sidebarWidth + SIDEBAR_OUTER_GUTTER_WIDTH;
  const sidebarOuterWidth = sidebarCollapsed ? 0 : sidebarPanelOuterWidth;
  const sidebarOuterHeight = sidebarHeight;

  const expandSidebar = useCallback(async () => {
    const expandedFitWidth = getExpandedSidebarFitWidth(
      getResponsiveSidebarWidth(preferredSidebarWidth, getViewportWidth()),
    );

    try {
      await ensureWindowWidth(expandedFitWidth);
    } catch (error) {
      console.warn("Failed to resize window before expanding sidebar:", error);
    }

    setSidebarCollapseState({ collapsed: false, reason: null });
  }, [preferredSidebarWidth]);

  const collapseSidebar = useCallback(() => {
    setSidebarCollapseState({ collapsed: true, reason: "manual" });
  }, []);

  const toggleSidebar = useCallback(() => {
    if (sidebarCollapsed) {
      void expandSidebar();
      return;
    }

    collapseSidebar();
  }, [collapseSidebar, expandSidebar, sidebarCollapsed]);

  const startResize = useCallback(
    (event: ReactMouseEvent, axis: "width" | "height" | "both") => {
      event.preventDefault();
      setIsResizing(true);
      const startX = event.clientX;
      const startY = event.clientY;
      const startWidth = sidebarCollapsed ? 0 : sidebarWidth;
      const startHeight = sidebarHeight;
      let shouldCollapse = false;

      if (axis === "height" || axis === "both") {
        patchSidebarLayout({ heightCustomized: true });
      }

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (axis === "width" || axis === "both") {
          const deltaX = moveEvent.clientX - startX;
          const newWidth = startWidth + deltaX;

          if (newWidth < SIDEBAR_SNAP_COLLAPSE_THRESHOLD) {
            shouldCollapse = true;
            patchSidebarLayout({ width: SIDEBAR_MIN_WIDTH });
          } else {
            shouldCollapse = false;
            setSidebarCollapseState({ collapsed: false, reason: null });
            patchSidebarLayout({ width: clampSidebarWidth(newWidth) });
          }
        }

        if (axis === "height" || axis === "both") {
          const deltaY = moveEvent.clientY - startY;
          patchSidebarLayout({
            height: clampSidebarHeight(startHeight + deltaY),
            heightCustomized: true,
          });
        }
      };

      const cleanup = () => {
        setIsResizing(false);
        if (shouldCollapse) {
          setSidebarCollapseState({ collapsed: true, reason: "manual" });
        }
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", cleanup);
        window.removeEventListener("blur", cleanup);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor =
        axis === "both"
          ? "nwse-resize"
          : axis === "height"
            ? "row-resize"
            : "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", cleanup);
      window.addEventListener("blur", cleanup);
    },
    [patchSidebarLayout, sidebarCollapsed, sidebarHeight, sidebarWidth],
  );

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent) => {
      startResize(event, "width");
    },
    [startResize],
  );

  const handleHeightResizeStart = useCallback(
    (event: ReactMouseEvent) => {
      startResize(event, "height");
    },
    [startResize],
  );

  const handleCornerResizeStart = useCallback(
    (event: ReactMouseEvent) => {
      startResize(event, "both");
    },
    [startResize],
  );

  const handleResizeDoubleClick = useCallback(() => {
    patchSidebarLayout({ width: SIDEBAR_DEFAULT_WIDTH });
    void ensureWindowWidth(getExpandedSidebarFitWidth(SIDEBAR_DEFAULT_WIDTH))
      .catch((error) => {
        console.warn(
          "Failed to resize window before resetting sidebar:",
          error,
        );
      })
      .finally(() =>
        setSidebarCollapseState({ collapsed: false, reason: null }),
      );
  }, [patchSidebarLayout]);

  const handleHeightResizeDoubleClick = useCallback(() => {
    patchSidebarLayout({
      height: clampSidebarHeight(getDefaultSidebarHeight()),
      heightCustomized: false,
    });
  }, [patchSidebarLayout]);

  const handleCornerResizeDoubleClick = useCallback(() => {
    handleResizeDoubleClick();
    handleHeightResizeDoubleClick();
  }, [handleHeightResizeDoubleClick, handleResizeDoubleClick]);

  useEffect(() => {
    void syncWindowMinimumSize().catch((error) => {
      console.warn("Failed to update window minimum size:", error);
    });
  }, []);

  useEffect(() => {
    const syncWindowResizeState = (markResizeActive: boolean) => {
      const nextViewportWidth = getViewportWidth();
      setViewportWidth((currentViewportWidth) =>
        currentViewportWidth === nextViewportWidth
          ? currentViewportWidth
          : nextViewportWidth,
      );
      setSidebarCollapseState((currentState) => {
        const shouldCollapse =
          shouldCollapseSidebarForViewport(nextViewportWidth);

        if (shouldCollapse) {
          return currentState.collapsed
            ? currentState
            : { collapsed: true, reason: "viewport" };
        }

        if (currentState.collapsed && currentState.reason === "viewport") {
          return { collapsed: false, reason: null };
        }

        if (!currentState.collapsed && currentState.reason !== null) {
          return { collapsed: false, reason: null };
        }

        return currentState;
      });

      if (!markResizeActive) return;
      setIsWindowResizing(true);
      if (windowResizeSettleTimerRef.current !== null) {
        window.clearTimeout(windowResizeSettleTimerRef.current);
      }
      windowResizeSettleTimerRef.current = window.setTimeout(() => {
        windowResizeSettleTimerRef.current = null;
        setIsWindowResizing(false);
      }, WINDOW_RESIZE_SETTLE_MS);
    };
    const handleWindowResize = () => syncWindowResizeState(true);

    syncWindowResizeState(false);
    window.addEventListener("resize", handleWindowResize);
    return () => {
      window.removeEventListener("resize", handleWindowResize);
      if (windowResizeSettleTimerRef.current !== null) {
        window.clearTimeout(windowResizeSettleTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const handleWindowResize = () => {
      setSidebarLayout((layout) => {
        const nextHeight = layout.heightCustomized
          ? clampSidebarHeight(layout.height)
          : getDefaultSidebarHeight();

        return nextHeight === layout.height
          ? layout
          : { ...layout, height: nextHeight };
      });
    };

    handleWindowResize();
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [setSidebarLayout]);

  return {
    expandSidebar,
    handleCornerResizeDoubleClick,
    handleCornerResizeStart,
    handleHeightResizeDoubleClick,
    handleHeightResizeStart,
    handleResizeDoubleClick,
    handleResizeStart,
    isCollapsed: sidebarCollapsed,
    isResizing: isResizing || isWindowResizing,
    resizeHandleHeight: SIDEBAR_RESIZE_HANDLE_HEIGHT,
    resizeHandleWidth: SIDEBAR_RESIZE_HANDLE_WIDTH,
    sidebarCollapsed,
    sidebarHeight,
    sidebarOuterHeight,
    sidebarOuterWidth,
    sidebarPanelOuterWidth,
    sidebarWidth,
    toggleCollapse: toggleSidebar,
    toggleSidebar,
    viewportWidth,
  };
}
