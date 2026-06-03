import type { ElementType } from "react";
import { cn } from "@/shared/lib/cn";
import { SIDEBAR_NAV_ICON_CLASS } from "./sidebarNavIcons";
import {
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
  SIDEBAR_NAV_ROW_SPACING_CLASS,
  SIDEBAR_NAV_TEXT_CLASS,
} from "@/shared/ui/sidebar-tokens";
import { getDesignSystemMetadata } from "@/shared/ui/design-system/metadata";

interface SidebarNavItemProps {
  icon?: ElementType<{ className?: string }>;
  label: string;
  collapsed: boolean;
  labelTransition: string;
  labelVisible: boolean;
  isActive: boolean;
  onClick: () => void;
  testId?: string;
  navId?: string;
  labelTransitionDelay?: string;
}

export function SidebarNavItem({
  icon: Icon,
  label,
  collapsed,
  labelTransition,
  labelVisible,
  isActive,
  onClick,
  testId,
  navId,
  labelTransitionDelay,
}: SidebarNavItemProps) {
  const className = cn(
    "flex items-center w-full rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring",
    SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
    SIDEBAR_NAV_TEXT_CLASS,
    SIDEBAR_NAV_ROW_SPACING_CLASS,
    isActive
      ? "bg-sidebar-accent text-sidebar-foreground"
      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground",
  );

  return (
    <button
      {...getDesignSystemMetadata({
        component: "SidebarNavItem",
        slot: "sidebar-nav-item",
        source: "src/features/sidebar/ui/SidebarNavItem.tsx",
        props: {
          isActive,
          collapsed,
        },
        customClassName: className,
      })}
      type="button"
      data-testid={testId}
      data-sidebar-nav-id={navId}
      onClick={onClick}
      title={collapsed ? label : undefined}
      aria-label={label}
      aria-current={isActive ? "page" : undefined}
      className={className}
    >
      {Icon ? <Icon className={SIDEBAR_NAV_ICON_CLASS} /> : null}
      <span
        className={cn(
          "whitespace-nowrap",
          labelTransition,
          labelVisible ? "opacity-100 w-auto" : "opacity-0 w-0 overflow-hidden",
        )}
        style={{ transitionDelay: labelTransitionDelay }}
      >
        {label}
      </span>
    </button>
  );
}
