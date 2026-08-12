import type * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@/shared/lib/cn";

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

type PopoverContentProps = React.ComponentProps<
  typeof PopoverPrimitive.Content
> & {
  variant?: "default" | "tooltip";
};

function PopoverContent({
  className,
  align = "center",
  sideOffset,
  variant = "default",
  children,
  ...props
}: PopoverContentProps) {
  const isTooltipVariant = variant === "tooltip";
  const resolvedSideOffset = sideOffset ?? (isTooltipVariant ? 0 : 4);

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        data-variant={variant}
        align={align}
        sideOffset={resolvedSideOffset}
        className={cn(
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 origin-(--radix-popover-content-transform-origin) rounded-md outline-hidden",
          isTooltipVariant
            ? "bg-popover-inverse text-popover-inverse-foreground w-fit px-3 py-1.5 text-xs shadow-popover"
            : "bg-popover text-popover-foreground w-72 p-4 shadow-popover",
          className,
        )}
        {...props}
      >
        {children}
        {/* Tooltip variant is for stable, interactive tooltip-like moments that need popover behavior, such as dismiss buttons or actions. */}
        {isTooltipVariant ? (
          <PopoverPrimitive.Arrow className="bg-popover-inverse fill-popover-inverse z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]" />
        ) : null}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
