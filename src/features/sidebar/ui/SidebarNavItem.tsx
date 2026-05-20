import type { ComponentType } from "react";
import { cn } from "@/shared/lib/cn";
import { getDesignSystemMetadata } from "@/shared/ui/design-system/metadata";

interface SidebarNavItemProps {
  icon?: ComponentType<{ className?: string }>;
  label: string;
  collapsed: boolean;
  labelTransition: string;
  labelVisible: boolean;
  isActive: boolean;
  onClick: () => void;
  testId?: string;
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
  labelTransitionDelay,
}: SidebarNavItemProps) {
  const className = cn(
    "flex items-center w-full text-sm font-light transition-colors duration-200 rounded-md",
    Icon ? "gap-2.5 px-3 py-1.5" : "px-3 py-1.5",
    isActive
      ? "bg-background-alt text-foreground"
      : "text-muted-foreground hover:bg-background-alt hover:text-foreground",
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
      onClick={onClick}
      title={collapsed ? label : undefined}
      aria-label={label}
      aria-current={isActive ? "page" : undefined}
      className={className}
    >
      {Icon ? <Icon className="size-4 flex-shrink-0" /> : null}
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
