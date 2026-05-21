import {
  useCallback,
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

const SIDEBAR_OUTER_GUTTER_WIDTH = 12;
const SIDEBAR_RESIZE_HANDLE_WIDTH = 12;
const SIDEBAR_RESIZE_HANDLE_HEIGHT = 12;
const SIDEBAR_DEFAULT_WIDTH = 256;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_DEFAULT_HEIGHT_RATIO = 2 / 3;
const SIDEBAR_MIN_HEIGHT = 320;
const SIDEBAR_SNAP_COLLAPSE_THRESHOLD = 100;
const APP_SHELL_PANEL_GUTTER_BOTTOM_FALLBACK = 12;
const APP_SHELL_TOP_BAR_HEIGHT = 56;
const APP_SHELL_HORIZONTAL_CHROME_WIDTH = 28;
const MIN_MAIN_CONTENT_WIDTH = 532;
const MIN_WINDOW_HEIGHT = 600;
const COLLAPSED_WINDOW_MIN_WIDTH =
  APP_SHELL_HORIZONTAL_CHROME_WIDTH + MIN_MAIN_CONTENT_WIDTH;

function getExpandedSidebarFitWidth(sidebarWidth: number) {
  return (
    sidebarWidth + APP_SHELL_HORIZONTAL_CHROME_WIDTH + MIN_MAIN_CONTENT_WIDTH
  );
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

function getSidebarFrameHeight() {
  if (typeof window === "undefined") {
    return (
      MIN_WINDOW_HEIGHT -
      APP_SHELL_TOP_BAR_HEIGHT -
      APP_SHELL_PANEL_GUTTER_BOTTOM_FALLBACK
    );
  }

  return Math.max(
    SIDEBAR_MIN_HEIGHT,
    window.innerHeight - APP_SHELL_TOP_BAR_HEIGHT - getAppPanelGutterBottom(),
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [sidebarHeight, setSidebarHeight] = useState(getDefaultSidebarHeight);
  const [sidebarHeightCustomized, setSidebarHeightCustomized] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  const sidebarOuterWidth = sidebarCollapsed
    ? 0
    : sidebarWidth + SIDEBAR_OUTER_GUTTER_WIDTH;
  const sidebarOuterHeight = sidebarCollapsed ? 0 : sidebarHeight;

  const expandSidebar = useCallback(async () => {
    const expandedFitWidth = getExpandedSidebarFitWidth(sidebarWidth);

    try {
      await ensureWindowWidth(expandedFitWidth);
    } catch (error) {
      console.warn("Failed to resize window before expanding sidebar:", error);
    }

    setSidebarCollapsed(false);
  }, [sidebarWidth]);

  const collapseSidebar = useCallback(() => {
    setSidebarCollapsed(true);
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
        setSidebarHeightCustomized(true);
      }

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (axis === "width" || axis === "both") {
          const deltaX = moveEvent.clientX - startX;
          const newWidth = startWidth + deltaX;

          if (newWidth < SIDEBAR_SNAP_COLLAPSE_THRESHOLD) {
            shouldCollapse = true;
            setSidebarWidth(SIDEBAR_MIN_WIDTH);
          } else {
            shouldCollapse = false;
            setSidebarCollapsed(false);
            setSidebarWidth(
              Math.min(
                SIDEBAR_MAX_WIDTH,
                Math.max(SIDEBAR_MIN_WIDTH, newWidth),
              ),
            );
          }
        }

        if (axis === "height" || axis === "both") {
          const deltaY = moveEvent.clientY - startY;
          setSidebarHeight(clampSidebarHeight(startHeight + deltaY));
        }
      };

      const cleanup = () => {
        setIsResizing(false);
        if (shouldCollapse) setSidebarCollapsed(true);
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
    [sidebarCollapsed, sidebarHeight, sidebarWidth],
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
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    void ensureWindowWidth(getExpandedSidebarFitWidth(SIDEBAR_DEFAULT_WIDTH))
      .catch((error) => {
        console.warn(
          "Failed to resize window before resetting sidebar:",
          error,
        );
      })
      .finally(() => setSidebarCollapsed(false));
  }, []);

  const handleHeightResizeDoubleClick = useCallback(() => {
    setSidebarHeightCustomized(false);
    setSidebarHeight(clampSidebarHeight(getDefaultSidebarHeight()));
  }, []);

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
    if (sidebarCollapsed) {
      return;
    }

    const handleWindowResize = () => {
      if (window.innerWidth < getExpandedSidebarFitWidth(sidebarWidth)) {
        setSidebarCollapsed(true);
      }
    };

    handleWindowResize();
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [sidebarCollapsed, sidebarWidth]);

  useEffect(() => {
    const handleWindowResize = () => {
      setSidebarHeight((height) =>
        sidebarHeightCustomized
          ? clampSidebarHeight(height)
          : getDefaultSidebarHeight(),
      );
    };

    handleWindowResize();
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [sidebarHeightCustomized]);

  return {
    expandSidebar,
    handleCornerResizeDoubleClick,
    handleCornerResizeStart,
    handleHeightResizeDoubleClick,
    handleHeightResizeStart,
    handleResizeDoubleClick,
    handleResizeStart,
    isCollapsed: sidebarCollapsed,
    isResizing,
    resizeHandleHeight: SIDEBAR_RESIZE_HANDLE_HEIGHT,
    resizeHandleWidth: SIDEBAR_RESIZE_HANDLE_WIDTH,
    sidebarCollapsed,
    sidebarHeight,
    sidebarOuterHeight,
    sidebarOuterWidth,
    sidebarWidth,
    toggleCollapse: toggleSidebar,
    toggleSidebar,
  };
}
