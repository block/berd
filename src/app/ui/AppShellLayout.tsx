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
  sidebarOuterWidth,
  topBar,
}: AppShellLayoutProps) {
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-dot-grid text-foreground">
      <TopBar {...topBar} />

      <div className="goose-zoom-scope flex flex-1 min-h-0 overflow-hidden">
        <div
          className="flex-shrink-0 h-full pt-[var(--spacing-app-panel-gutter-top)] pb-3 pl-3"
          style={{
            width: sidebarOuterWidth,
            transition: isResizing ? "none" : "width 200ms ease-out",
          }}
        >
          <Sidebar {...sidebar} />
        </div>

        {/* biome-ignore lint/a11y/noStaticElementInteractions: drag handle for sidebar resize */}
        <div
          onMouseDown={onResizeStart}
          onDoubleClick={onResizeDoubleClick}
          className="group flex h-full flex-shrink-0 cursor-col-resize items-center justify-center"
          style={{ width: resizeHandleWidth }}
        >
          <div className="h-8 w-px rounded-full bg-transparent transition-colors group-hover:bg-border" />
        </div>

        <main className="min-h-0 min-w-0 flex-1">{children}</main>
      </div>

      <CreateProjectDialog {...createProjectDialog} />
      {isDesignSystemExplorerEnabled() ? <DesignSystemInspector /> : null}
    </div>
  );
}
