import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button, type ButtonProps } from "@/shared/ui/button";

/** White, rounded actions that sit beside page-level tabs and filters. */
const PAGE_TOOLBAR_RECIPE =
  "!h-[30px] bg-background text-muted-foreground shadow-none hover:bg-background hover:text-foreground focus-visible:text-foreground active:bg-background active:text-foreground data-[state=open]:bg-background data-[state=open]:text-foreground aria-expanded:bg-background aria-expanded:text-foreground";

export type PageToolbarButtonProps = Omit<
  ButtonProps,
  "variant" | "flush" | "destructive"
>;

export const PageToolbarButton = React.forwardRef<
  HTMLButtonElement,
  PageToolbarButtonProps
>(({ className, ...props }, ref) => (
  <Button
    ref={ref}
    variant="subtle"
    className={cn(
      PAGE_TOOLBAR_RECIPE,
      typeof props.size === "string" &&
        props.size.startsWith("icon") &&
        "!size-[30px] !p-[7px]",
      className,
    )}
    {...props}
  />
));
PageToolbarButton.displayName = "PageToolbarButton";
