import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button, type ButtonProps } from "@/shared/ui/button";

/** Quiet disclosure action used for View more, View less, and View all rows. */
const SIDEBAR_DISCLOSURE_RECIPE =
  "text-muted-foreground/75 hover:text-muted-foreground active:text-muted-foreground";
const SIDEBAR_DISCLOSURE_ROW_RECIPE =
  "hover:bg-[var(--sidebar-row-hover)] active:bg-[var(--sidebar-row-active)] focus-visible:bg-[var(--sidebar-row-hover)]";

export type SidebarDisclosureButtonProps = Omit<
  ButtonProps,
  "variant" | "flush" | "size"
> & {
  row?: boolean;
};

export const SidebarDisclosureButton = React.forwardRef<
  HTMLButtonElement,
  SidebarDisclosureButtonProps
>(({ className, row = false, ...props }, ref) => (
  <Button
    ref={ref}
    variant="ghost"
    flush={!row}
    size="xs"
    className={cn(
      SIDEBAR_DISCLOSURE_RECIPE,
      row && SIDEBAR_DISCLOSURE_ROW_RECIPE,
      className,
    )}
    {...props}
  />
));
SidebarDisclosureButton.displayName = "SidebarDisclosureButton";
