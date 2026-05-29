import type {
  ComponentProps,
  CSSProperties,
  MouseEventHandler,
  ReactNode,
} from "react";
import { Sidebar } from "@/features/sidebar/ui/Sidebar";
import { CreateProjectDialog } from "@/features/projects/ui/CreateProjectDialog";
import { DesignSystemInspector } from "@/features/design-system/inspector/DesignSystemInspector";
import { isDesignSystemExplorerEnabled } from "@/features/design-system/lib/designSystemEnabled";
import { cn } from "@/shared/lib/cn";
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
  showDesignSystemInspector,
  topBar,
}: AppShellLayoutProps) {
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

      <div className="goose-zoom-scope relative flex flex-1 min-h-0 overflow-hidden">
        <div
          className={cn(
            contentUnderSidebar
              ? "relative z-20 flex-shrink-0 overflow-visible select-none"
              : "relative z-20 flex-shrink-0 overflow-visible",
            contentUnderTopBar && "mt-[var(--spacing-app-top-bar)]",
          )}
          style={{
            height: sidebarOuterHeight,
            maxHeight: contentUnderTopBar
              ? "calc(100% - var(--spacing-app-panel-gutter-bottom) - var(--spacing-app-top-bar))"
              : "calc(100% - var(--spacing-app-panel-gutter-bottom))",
            width: sidebarOuterWidth,
            opacity: sidebarCollapsed ? 0 : 1,
            transition: isResizing
              ? "none"
              : "height 220ms ease-out, width 220ms ease-out, opacity 180ms ease-out",
            pointerEvents: sidebarCollapsed ? "none" : undefined,
          }}
          aria-hidden={sidebarCollapsed || undefined}
        >
          <div className="h-full pt-[var(--spacing-app-panel-gutter-top)] pl-3">
            <Sidebar {...sidebar} />
          </div>
          <div
            onMouseDown={onResizeStart}
            onDoubleClick={onResizeDoubleClick}
            className="group absolute top-0 right-0 bottom-0 z-10 flex translate-x-1/2 cursor-col-resize items-center justify-center overflow-hidden"
            style={{
              width: sidebarCollapsed ? 0 : resizeHandleWidth * 2,
              opacity: sidebarCollapsed ? 0 : 1,
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
            maxHeight: contentUnderTopBar
              ? "calc(100% - var(--spacing-app-panel-gutter-bottom) - var(--spacing-app-top-bar))"
              : "calc(100% - var(--spacing-app-panel-gutter-bottom))",
            width: 0,
            opacity: sidebarCollapsed ? 0 : 1,
            transition: isResizing
              ? "none"
              : "height 220ms ease-out, width 220ms ease-out, opacity 180ms ease-out",
            pointerEvents: sidebarCollapsed ? "none" : undefined,
          }}
          aria-hidden={sidebarCollapsed || undefined}
        />

        <main
          className={
            contentUnderSidebar
              ? "absolute inset-0 z-0 min-h-0 min-w-0"
              : "min-h-0 min-w-0 flex-1"
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
