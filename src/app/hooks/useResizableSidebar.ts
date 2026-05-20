import {
  useCallback,
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { SIDE_PANEL_DEFAULT_WIDTH } from "@/shared/constants/panels";

const SIDEBAR_OUTER_GUTTER_WIDTH = 12;
const SIDEBAR_RESIZE_HANDLE_WIDTH = 12;
const SIDEBAR_DEFAULT_WIDTH = SIDE_PANEL_DEFAULT_WIDTH;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 380;
const SIDEBAR_SNAP_COLLAPSE_THRESHOLD = 100;
const SIDEBAR_COLLAPSED_WIDTH = 48;
const APP_SHELL_HORIZONTAL_CHROME_WIDTH = 28;
const MIN_MAIN_CONTENT_WIDTH = 532;
const MIN_WINDOW_HEIGHT = 600;
const COLLAPSED_WINDOW_MIN_WIDTH =
  SIDEBAR_COLLAPSED_WIDTH +
  APP_SHELL_HORIZONTAL_CHROME_WIDTH +
  MIN_MAIN_CONTENT_WIDTH;

function getExpandedSidebarFitWidth(sidebarWidth: number) {
  return (
    sidebarWidth + APP_SHELL_HORIZONTAL_CHROME_WIDTH + MIN_MAIN_CONTENT_WIDTH
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
  const [isResizing, setIsResizing] = useState(false);

  const sidebarOuterWidth = sidebarCollapsed
    ? SIDEBAR_COLLAPSED_WIDTH + SIDEBAR_OUTER_GUTTER_WIDTH
    : sidebarWidth + SIDEBAR_OUTER_GUTTER_WIDTH;

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

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      setIsResizing(true);
      const startX = event.clientX;
      const startWidth = sidebarCollapsed
        ? SIDEBAR_COLLAPSED_WIDTH
        : sidebarWidth;
      let shouldCollapse = false;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startX;
        const newWidth = startWidth + delta;

        if (newWidth < SIDEBAR_SNAP_COLLAPSE_THRESHOLD) {
          shouldCollapse = true;
          setSidebarWidth(SIDEBAR_MIN_WIDTH);
        } else {
          shouldCollapse = false;
          setSidebarCollapsed(false);
          setSidebarWidth(
            Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, newWidth)),
          );
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
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", cleanup);
      window.addEventListener("blur", cleanup);
    },
    [sidebarCollapsed, sidebarWidth],
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

  return {
    expandSidebar,
    handleResizeDoubleClick,
    handleResizeStart,
    isCollapsed: sidebarCollapsed,
    isResizing,
    resizeHandleWidth: SIDEBAR_RESIZE_HANDLE_WIDTH,
    sidebarCollapsed,
    sidebarOuterWidth,
    sidebarWidth,
    toggleCollapse: toggleSidebar,
    toggleSidebar,
  };
}
