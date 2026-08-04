import type { ElementType, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { SIDEBAR_NAV_ICON_CLASS } from "./sidebarNavIcons";
import {
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
  SIDEBAR_NAV_ROW_SPACING_CLASS,
  SIDEBAR_NAV_TEXT_CLASS,
  SIDEBAR_ROW_ACTIVE_CLASS,
  SIDEBAR_ROW_HOVER_CLASS,
  SIDEBAR_ROW_HEIGHT_CLASS,
  SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS,
  SIDEBAR_ROW_TEXT_DEFAULT_CLASS,
  SIDEBAR_ROW_VERTICAL_PADDING_CLASS,
} from "@/shared/ui/sidebar-tokens";
import { getDesignSystemMetadata } from "@/shared/ui/design-system/metadata";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

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
  // Optional trailing affordance (e.g. an "update available" indicator).
  // Rendered inline at the right edge when expanded, and as a small overlay
  // dot at the leading icon's corner when collapsed.
  trailingIcon?: ReactNode;
  // Screen-reader-only text appended for the trailing affordance, so the
  // indicator is announced even when the lucide icon is aria-hidden.
  trailingLabel?: string;
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
  trailingIcon,
  trailingLabel,
}: SidebarNavItemProps) {
  const rowSpacingClass = collapsed
    ? cn(
        SIDEBAR_ROW_HEIGHT_CLASS,
        SIDEBAR_ROW_HORIZONTAL_PADDING_CLASS,
        SIDEBAR_ROW_VERTICAL_PADDING_CLASS,
        "justify-center",
      )
    : SIDEBAR_NAV_ROW_SPACING_CLASS;

  const className = cn(
    "flex items-center w-full rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring",
    SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
    SIDEBAR_NAV_TEXT_CLASS,
    rowSpacingClass,
    isActive
      ? SIDEBAR_ROW_ACTIVE_CLASS
      : cn(SIDEBAR_ROW_TEXT_DEFAULT_CLASS, SIDEBAR_ROW_HOVER_CLASS),
  );

  const ariaLabel = trailingLabel ? `${label} — ${trailingLabel}` : label;

  const button = (
    <button
      {...getDesignSystemMetadata({
        component: "SidebarNavItem",
        slot: "sidebar-nav-item",
        source: "src/features/navigation/ui/SidebarNavItem.tsx",
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
      aria-label={ariaLabel}
      aria-current={isActive ? "page" : undefined}
      className={className}
    >
      {Icon ? (
        <span className="relative inline-flex shrink-0">
          <Icon className={SIDEBAR_NAV_ICON_CLASS} />
          {trailingIcon && collapsed ? (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-warning"
            />
          ) : null}
        </span>
      ) : null}
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
      {trailingIcon && !collapsed ? (
        <span className="ml-auto inline-flex shrink-0 items-center">
          {trailingIcon}
          {trailingLabel ? (
            <span className="sr-only">{trailingLabel}</span>
          ) : null}
        </span>
      ) : null}
      {trailingIcon && collapsed && trailingLabel ? (
        <span className="sr-only">{trailingLabel}</span>
      ) : null}
    </button>
  );

  if (!collapsed) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{ariaLabel}</TooltipContent>
    </Tooltip>
  );
}
