import type {
  CSSProperties,
  KeyboardEventHandler,
  ReactNode,
  Ref,
} from "react";
import { PaneSurface } from "@/app/layout/panes/paneChrome";
import { cn } from "@/shared/lib/cn";
import { SIDEBAR_PANEL_ELEVATED_HOVER_SHADOW_CLASS } from "@/shared/ui/sidebar-tokens";
import {
  SidebarProjectsSection,
  type SidebarProjectsSectionProps,
} from "@/features/sessions/ui/session-list/SidebarProjectsSection";

interface SessionListSurfaceProps {
  ariaLabel?: string;
  bottomMaskStyle?: CSSProperties;
  dragging?: boolean;
  elevatedHoverShadow?: boolean;
  navRef?: Ref<HTMLElement>;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  preview?: boolean;
  renderDragHandle: () => ReactNode;
  renderResizeRail?: () => ReactNode;
  sectionProps: SidebarProjectsSectionProps;
  showBottomMask?: boolean;
  sideDocked?: boolean;
  variant: "embedded" | "panel";
}

export function SessionListSurface({
  ariaLabel,
  bottomMaskStyle,
  dragging = false,
  elevatedHoverShadow = false,
  navRef,
  onKeyDown,
  preview = false,
  renderDragHandle,
  renderResizeRail,
  sectionProps,
  showBottomMask = false,
  sideDocked = false,
  variant,
}: SessionListSurfaceProps) {
  if (variant === "embedded") {
    return (
      <div
        className={cn(
          "transition-opacity duration-150",
          dragging && "opacity-20",
        )}
      >
        {renderDragHandle()}
        <SidebarProjectsSection {...sectionProps} />
      </div>
    );
  }

  return (
    <PaneSurface
      className={cn(
        "h-full transition-shadow duration-200 ease-out",
        preview && "shadow-sidebar-panel-elevated",
        !preview &&
          elevatedHoverShadow &&
          SIDEBAR_PANEL_ELEVATED_HOVER_SHADOW_CLASS,
      )}
      dataAttributes={{
        "data-sidebar-session-list-panel": preview ? undefined : true,
      }}
      testId={
        preview ? "sidebar-session-list-preview" : "sidebar-session-list-panel"
      }
    >
      {renderDragHandle()}
      <nav
        ref={preview ? undefined : navRef}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2.5 pt-1 pb-1 scrollbar-none"
        style={showBottomMask ? bottomMaskStyle : undefined}
        aria-label={ariaLabel}
      >
        <SidebarProjectsSection {...sectionProps} />
      </nav>
      {!preview && sideDocked && renderResizeRail?.()}
    </PaneSurface>
  );
}
