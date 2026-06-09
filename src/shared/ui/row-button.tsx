import type * as React from "react";
import { cn } from "@/shared/lib/cn";

const rowButtonVariants = {
  // Bordered, input-like control: pickers and field-style triggers.
  field: cn(
    "flex w-full items-center gap-2 rounded-md border border-border px-2.5 py-2",
    "text-sm text-foreground transition-colors",
    "hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
    "disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-transparent",
  ),
  // Borderless option row inside popovers and menus.
  menu: cn(
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
    "hover:bg-muted focus-visible:outline-none focus-visible:bg-muted",
    "disabled:opacity-50",
  ),
} as const;

export type RowButtonVariant = keyof typeof rowButtonVariants;

export interface RowButtonProps extends React.ComponentProps<"button"> {
  variant?: RowButtonVariant;
  selected?: boolean;
  icon?: React.ReactNode;
  label: React.ReactNode;
  description?: React.ReactNode;
  trailing?: React.ReactNode;
}

/**
 * A row-shaped button: leading icon, one- or two-line label, optional
 * trailing adornment. Use `field` for standalone bordered controls and
 * `menu` for option rows inside popovers.
 */
export function RowButton({
  variant = "menu",
  selected = false,
  icon,
  label,
  description,
  trailing,
  className,
  type = "button",
  ...props
}: RowButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        rowButtonVariants[variant],
        selected && "bg-muted",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-foreground">{label}</span>
        {description ? (
          <span className="block truncate text-xs text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
      {trailing}
    </button>
  );
}
