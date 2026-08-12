import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

export function PickerItem({
  children,
  onClick,
  selected = false,
  disabled = false,
  className,
  ...rest
}: {
  children: ReactNode;
  selected?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type">) {
  return (
    <button
      type="button"
      data-picker-nav-item
      onClick={onClick}
      disabled={disabled}
      // Marks the selected row so column-level focus selectors
      // ("[data-col] button[data-selected]") can find it.
      data-selected={selected || undefined}
      className={cn(
        "flex min-w-0 w-full items-center gap-2 overflow-hidden rounded-sm px-2 py-1.5 text-left text-sm transition-colors",
        "hover:bg-accent focus-visible:bg-accent focus:outline-none",
        "disabled:pointer-events-none disabled:opacity-50",
        selected && "bg-accent",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
