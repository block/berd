import type * as React from "react";
import * as TogglePrimitive from "@radix-ui/react-toggle";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/cn";
import { getDesignSystemMetadata } from "@/shared/ui/design-system/metadata";

const toggleVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm text-text-muted hover:bg-background-hover hover:text-text-default disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-background-muted data-[state=on]:text-text-default [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 focus-visible:border-border-focus focus-visible:ring-ring-focus/50 focus-visible:ring-[1px] outline-none transition-[color,box-shadow] aria-invalid:ring-border-danger/20 dark:aria-invalid:ring-border-danger/40 aria-invalid:border-border-danger whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline:
          "border border-border-input bg-transparent hover:bg-background-hover hover:text-text-default",
      },
      size: {
        default: "h-9 px-2 min-w-9",
        sm: "h-8 px-1.5 min-w-8",
        lg: "h-10 px-2.5 min-w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Toggle({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> &
  VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      {...getDesignSystemMetadata({
        component: "Toggle",
        slot: "toggle",
        source: "src/shared/ui/toggle.tsx",
        variant: variant ?? "default",
        size: size ?? "default",
        props: {
          disabled: props.disabled,
          pressed: props.pressed,
        },
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
