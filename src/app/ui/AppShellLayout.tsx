import type { ComponentProps, MouseEventHandler, ReactNode } from "react";
import { Sidebar } from "@/features/sidebar/ui/Sidebar";
import { CreateProjectDialog } from "@/features/projects/ui/CreateProjectDialog";
import { DesignSystemInspector } from "@/features/design-system/inspector/DesignSystemInspector";
import { isDesignSystemExplorerEnabled } from "@/features/design-system/lib/designSystemEnabled";
import { TopBar } from "./TopBar";

interface AppShellLayoutProps {
  children: ReactNode;
  createProjectDialog: ComponentProps<typeof CreateProjectDialog>;
  isResizing: boolean;
  onResizeDoubleClick: MouseEventHandler<HTMLDivElement>;
  onResizeStart: MouseEventHandler<HTMLDivElement>;
  resizeHandleWidth: number;
  sidebar: ComponentProps<typeof Sidebar>;
  sidebarCollapsed: boolean;
  sidebarOuterWidth: number;
  topBar: ComponentProps<typeof TopBar>;
}

export function AppShellLayout({
  children,
  createProjectDialog,
  isResizing,
  onResizeDoubleClick,
  onResizeStart,
  resizeHandleWidth,
  sidebar,
  sidebarCollapsed,
  sidebarOuterWidth,
  topBar,
}: AppShellLayoutProps) {
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-dot-grid text-foreground">
      <TopBar {...topBar} />

      <div className="goose-zoom-scope flex flex-1 min-h-0 overflow-hidden">
        <div
          className="flex-shrink-0 h-full overflow-hidden"
          style={{
            width: sidebarOuterWidth,
            opacity: sidebarCollapsed ? 0 : 1,
            transition: isResizing
              ? "none"
              : "width 220ms ease-out, opacity 180ms ease-out",
            pointerEvents: sidebarCollapsed ? "none" : undefined,
          }}
          aria-hidden={sidebarCollapsed || undefined}
        >
          <div className="h-full pt-[var(--spacing-app-panel-gutter-top)] pb-3 pl-3">
            <Sidebar {...sidebar} />
          </div>
        </div>

        {/* biome-ignore lint/a11y/noStaticElementInteractions: drag handle for sidebar resize */}
        <div
          onMouseDown={onResizeStart}
          onDoubleClick={onResizeDoubleClick}
          className="flex-shrink-0 h-full cursor-col-resize group flex items-center justify-center overflow-hidden"
          style={{
            width: sidebarCollapsed ? 0 : resizeHandleWidth,
            opacity: sidebarCollapsed ? 0 : 1,
            transition: isResizing
              ? "none"
              : "width 220ms ease-out, opacity 180ms ease-out",
            pointerEvents: sidebarCollapsed ? "none" : undefined,
          }}
          aria-hidden={sidebarCollapsed || undefined}
        >
          <div className="w-px h-8 rounded-full bg-transparent group-hover:bg-border transition-colors" />
        </div>

        <main className="min-h-0 min-w-0 flex-1">{children}</main>
      </div>

      <CreateProjectDialog {...createProjectDialog} />
      {isDesignSystemExplorerEnabled() ? <DesignSystemInspector /> : null}
    </div>
  );
}
