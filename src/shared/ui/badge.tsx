import type * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/cn";
import { getDesignSystemMetadata } from "@/shared/ui/design-system/metadata";

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-pill border border-border-default px-2 py-0.5 text-xs w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-border-focus focus-visible:ring-ring-focus/50 focus-visible:ring-[1px] aria-invalid:ring-border-danger/20 dark:aria-invalid:ring-border-danger/40 aria-invalid:border-border-danger transition-[color,box-shadow] overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-background-primary text-text-on-primary [a&]:hover:bg-background-primary/90",
        secondary:
          "border-transparent bg-background-muted text-text-default [a&]:hover:bg-background-muted/90",
        destructive:
          "border-transparent bg-background-danger-strong text-text-on-danger-strong [a&]:hover:bg-background-danger-strong/90 focus-visible:ring-border-danger/20 dark:focus-visible:ring-border-danger/40",
        outline:
          "text-text-default [a&]:hover:bg-background-muted [a&]:hover:text-text-muted",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span";

  return (
    <Comp
      {...getDesignSystemMetadata({
        component: "Badge",
        slot: "badge",
        source: "src/shared/ui/badge.tsx",
        variant: variant ?? "default",
        props: { asChild },
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
