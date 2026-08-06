import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button, type ButtonProps } from "@/shared/ui/button";

/**
 * Icon action for compact toolbars inside content surfaces such as popovers.
 * Uses top-bar geometry without inheriting app-chrome colors or hover fills.
 */
const CONTENT_TOOLBAR_ICON_RECIPE =
  "bg-transparent text-foreground shadow-none transition-[color,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-transparent hover:text-foreground hover:opacity-[var(--app-top-bar-control-hover-opacity)] active:bg-transparent active:text-foreground active:opacity-[var(--app-top-bar-control-hover-opacity)] focus-visible:bg-transparent data-[state=open]:bg-transparent data-[state=open]:text-foreground data-[state=open]:opacity-[var(--app-top-bar-control-hover-opacity)] aria-expanded:bg-transparent aria-expanded:text-foreground aria-expanded:opacity-[var(--app-top-bar-control-hover-opacity)]";

export type ContentToolbarIconButtonProps = Omit<
  ButtonProps,
  "variant" | "flush"
>;

export const ContentToolbarIconButton = React.forwardRef<
  HTMLButtonElement,
  ContentToolbarIconButtonProps
>(({ className, size = "icon-top-bar", ...props }, ref) => (
  <Button
    ref={ref}
    variant="ghost"
    size={size}
    className={cn(CONTENT_TOOLBAR_ICON_RECIPE, className)}
    {...props}
  />
));
ContentToolbarIconButton.displayName = "ContentToolbarIconButton";
