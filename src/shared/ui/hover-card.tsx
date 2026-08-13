import type * as React from "react";
import * as HoverCardPrimitive from "@radix-ui/react-hover-card";

import { cn } from "@/shared/lib/cn";

function HoverCard({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />;
}

function HoverCardTrigger({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return (
    <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
  );
}

type HoverCardContentProps = React.ComponentProps<
  typeof HoverCardPrimitive.Content
> & {
  /** `tooltip` renders the inverse (dark) tooltip surface for hover
   * previews that need interactive content (scrolling, links) a plain
   * Tooltip cannot host. Mirrors PopoverContent's `tooltip` variant. */
  variant?: "default" | "tooltip";
};

function HoverCardContent({
  className,
  align = "center",
  sideOffset = 4,
  variant = "default",
  ...props
}: HoverCardContentProps) {
  return (
    <HoverCardPrimitive.Portal data-slot="hover-card-portal">
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        data-variant={variant}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 origin-(--radix-hover-card-content-transform-origin) rounded-md outline-hidden",
          variant === "tooltip"
            ? "bg-popover-inverse text-popover-inverse-foreground shadow-popover w-64 p-0"
            : "bg-popover text-popover-foreground shadow-popover w-64 p-4",
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
