import {
  useState,
  type ComponentProps,
  type CSSProperties,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { Sidebar } from "@/features/sidebar/ui/Sidebar";
import { CreateProjectDialog } from "@/features/projects/ui/CreateProjectDialog";
import { DesignSystemInspector } from "@/features/design-system/inspector/DesignSystemInspector";
import { isDesignSystemExplorerEnabled } from "@/features/design-system/lib/designSystemEnabled";
import { cn } from "@/shared/lib/cn";
import {
  SIDEBAR_COLLAPSE_TRANSITION_EASE,
  SIDEBAR_COLLAPSE_TRANSITION_MS,
} from "@/shared/ui/sidebar-tokens";
import { UpdateButton } from "@/features/updates/ui/UpdateButton";
import { TopBar } from "./TopBar";

interface AppShellLayoutProps {
  children: ReactNode;
  contentUnderSidebar?: boolean;
  /**
   * When true, the TopBar is positioned absolutely over the content so the
   * main canvas can extend up to the viewport edge. Used by the home view so
   * pinned widgets are reachable at all edges; the top-bar floats with no
   * solid background and shares the dot-grid surface underneath.
   */
  contentUnderTopBar?: boolean;
  projectTint?: string | null;
  createProjectDialog: ComponentProps<typeof CreateProjectDialog>;
  isResizing: boolean;
  onCornerResizeDoubleClick: MouseEventHandler<HTMLDivElement>;
  onCornerResizeStart: MouseEventHandler<HTMLDivElement>;
  onHeightResizeDoubleClick: MouseEventHandler<HTMLDivElement>;
  onHeightResizeStart: MouseEventHandler<HTMLDivElement>;
  onResizeDoubleClick: MouseEventHandler<HTMLDivElement>;
  onResizeStart: MouseEventHandler<HTMLDivElement>;
  resizeHandleHeight: number;
  resizeHandleWidth: number;
  sidebar: ComponentProps<typeof Sidebar>;
  sidebarCollapsed: boolean;
  sidebarOuterHeight: number;
  sidebarOuterWidth: number;
  /** Full slide panel width (content + gutter); stays constant while collapsing. */
  sidebarPanelOuterWidth: number;
  showDesignSystemInspector: boolean;
  topBar: ComponentProps<typeof TopBar>;
}

export function AppShellLayout({
  children,
  contentUnderSidebar = false,
  contentUnderTopBar = false,
  projectTint = null,
  createProjectDialog,
  isResizing,
  onCornerResizeDoubleClick,
  onCornerResizeStart,
  onHeightResizeDoubleClick,
  onHeightResizeStart,
  onResizeDoubleClick,
  onResizeStart,
  resizeHandleHeight,
  resizeHandleWidth,
  sidebar,
  sidebarCollapsed,
  sidebarOuterHeight,
  sidebarOuterWidth,
  sidebarPanelOuterWidth,
  showDesignSystemInspector,
  topBar,
}: AppShellLayoutProps) {
  const [sidebarHovered, setSidebarHovered] = useState(false);
  const sidebarElevated = sidebarHovered || isResizing;
  const sidebarSlideTransition = isResizing
    ? "none"
    : `transform ${SIDEBAR_COLLAPSE_TRANSITION_MS}ms ${SIDEBAR_COLLAPSE_TRANSITION_EASE}`;
  const sidebarHandleFadeTransition = isResizing
    ? "none"
    : `opacity ${SIDEBAR_COLLAPSE_TRANSITION_MS}ms ${SIDEBAR_COLLAPSE_TRANSITION_EASE}`;

  const sidebarSlotMaxHeight = contentUnderTopBar
    ? "calc(100% - var(--spacing-app-panel-gutter-bottom) - var(--spacing-app-top-bar))"
    : "calc(100% - var(--spacing-app-panel-gutter-bottom)";

  const shellStyle = {
    "--project-tint": projectTint ?? "transparent",
  } as CSSProperties;

  return (
    <div
      className="relative flex h-screen w-screen flex-col overflow-hidden bg-dot-grid text-foreground"
      style={shellStyle}
    >
      <TopBar
        {...topBar}
        className={
          contentUnderTopBar ? "absolute top-0 left-0 right-0 z-30" : undefined
        }
      />

      <div className="goose-zoom-scope relative flex min-h-0 flex-1">
        {/* Reserves horizontal space instantly; no width animation (slide only). */}
        <div
          className={cn(
            "flex-shrink-0",
            contentUnderTopBar && "mt-[var(--spacing-app-top-bar)]",
          )}
          style={{
            height: sidebarOuterHeight,
            maxHeight: sidebarSlotMaxHeight,
            width: sidebarOuterWidth,
          }}
          aria-hidden={sidebarCollapsed || undefined}
        />

        <div
          className={cn(
            // overflow-visible on every view: the sidebar card clips its own
            // content via `overflow-hidden rounded-chrome`, so the only things
            // that extend past this wrapper's right edge are the elevated panel
            // shadow and the resize rail (translate-x-1/2), both of which are
            // meant to float over the adjacent content. Clipping x here cropped
            // them on non-home pages.
            "absolute left-0 z-20 select-none overflow-visible",
            contentUnderTopBar && "mt-[var(--spacing-app-top-bar)]",
            sidebarElevated && "z-30",
          )}
          style={{
            height: sidebarOuterHeight,
            maxHeight: sidebarSlotMaxHeight,
            width: sidebarPanelOuterWidth,
            transform: sidebarCollapsed ? "translateX(-100%)" : "translateX(0)",
            transition: sidebarSlideTransition,
            pointerEvents: sidebarCollapsed ? "none" : undefined,
          }}
          aria-hidden={sidebarCollapsed || undefined}
          inert={sidebarCollapsed ? true : undefined}
          onMouseEnter={() => setSidebarHovered(true)}
          onMouseLeave={() => setSidebarHovered(false)}
        >
          <div className="relative h-full pt-[var(--spacing-app-panel-gutter-top)] pl-3">
            <Sidebar {...sidebar} elevatedShadow={sidebarElevated} />
          </div>
          <div
            onMouseDown={onResizeStart}
            onDoubleClick={onResizeDoubleClick}
            className="sidebar-resize-rail group absolute top-0 right-0 bottom-0 z-10 flex translate-x-1/2 cursor-col-resize items-center justify-center overflow-hidden"
            style={{
              width: sidebarCollapsed ? 0 : resizeHandleWidth * 2,
              opacity: sidebarCollapsed ? 0 : 1,
              transition: sidebarHandleFadeTransition,
            }}
            aria-hidden={sidebarCollapsed || undefined}
          >
            <div className="h-8 w-px rounded-full bg-transparent transition-colors group-hover:bg-border" />
          </div>
          <div
            onMouseDown={onHeightResizeStart}
            onDoubleClick={onHeightResizeDoubleClick}
            className="group absolute right-0 bottom-0 left-3 z-10 flex translate-y-1/2 cursor-row-resize items-center justify-center overflow-hidden"
            style={{
              height: sidebarCollapsed ? 0 : resizeHandleHeight * 2,
              opacity: sidebarCollapsed ? 0 : 1,
              transition: sidebarHandleFadeTransition,
            }}
            aria-hidden={sidebarCollapsed || undefined}
          >
            <div className="h-px w-8 rounded-full bg-transparent transition-colors group-hover:bg-border" />
          </div>
          <div
            onMouseDown={onCornerResizeStart}
            onDoubleClick={onCornerResizeDoubleClick}
            className="group absolute right-0 bottom-0 z-20 translate-x-1/2 translate-y-1/2 cursor-nwse-resize overflow-hidden"
            style={{
              height: sidebarCollapsed ? 0 : resizeHandleHeight * 2,
              width: sidebarCollapsed ? 0 : resizeHandleWidth * 2,
              opacity: sidebarCollapsed ? 0 : 1,
              transition: sidebarHandleFadeTransition,
            }}
            aria-hidden={sidebarCollapsed || undefined}
          >
            <div className="absolute top-1/2 left-1/2 h-px w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-transparent transition-colors group-hover:bg-border" />
            <div className="absolute top-1/2 left-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2 rounded-full bg-transparent transition-colors group-hover:bg-border" />
          </div>
        </div>

        <div
          onMouseDown={onResizeStart}
          onDoubleClick={onResizeDoubleClick}
          className={cn(
            "relative z-20 flex flex-shrink-0 cursor-col-resize items-center justify-center overflow-visible",
            contentUnderTopBar && "mt-[var(--spacing-app-top-bar)]",
          )}
          style={{
            height: sidebarOuterHeight,
            maxHeight: sidebarSlotMaxHeight,
            width: 0,
            opacity: sidebarCollapsed ? 0 : 1,
            transition: sidebarHandleFadeTransition,
            pointerEvents: sidebarCollapsed ? "none" : undefined,
          }}
          aria-hidden={sidebarCollapsed || undefined}
        />

        <main
          className={
            contentUnderSidebar
              ? "absolute inset-0 z-0 min-h-0 min-w-0"
              : "min-h-0 min-w-0 flex-1 overflow-hidden"
          }
        >
          {children}
        </main>
      </div>

      <UpdateButton />

      <CreateProjectDialog {...createProjectDialog} />
      {isDesignSystemExplorerEnabled() && showDesignSystemInspector ? (
        <DesignSystemInspector />
      ) : null}
    </div>
  );
}
