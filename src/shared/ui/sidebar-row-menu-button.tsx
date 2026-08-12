import * as React from "react";
import { Button, type ButtonProps } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";

/** Icon trigger for row overflow menus in sidebar navigation surfaces. */
export const SidebarRowMenuButton = React.forwardRef<
  HTMLButtonElement,
  Omit<ButtonProps, "variant" | "flush" | "size">
>(({ className, ...props }, ref) => (
  <Button
    ref={ref}
    type="button"
    variant="ghost"
    flush
    size="icon-xs"
    className={cn(
      "size-5 outline-none focus-visible:bg-sidebar-accent focus-visible:ring-0 focus-visible:ring-offset-0",
      className,
    )}
    {...props}
  />
));
SidebarRowMenuButton.displayName = "SidebarRowMenuButton";
