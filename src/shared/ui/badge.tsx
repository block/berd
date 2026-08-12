import type * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/cn";
import { getDesignSystemMetadata } from "@/shared/ui/design-system/metadata";

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-xs border border-border px-2 py-0.5 text-xs w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[1px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,box-shadow] overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "border-transparent bg-muted text-foreground [a&]:hover:bg-muted/90",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground [a&]:hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        inverse:
          "rounded-full border-transparent bg-surface-chat-responding-pill-bg px-4 py-2 text-sm text-surface-chat-responding-pill-fg",
        outline:
          "text-foreground [a&]:hover:bg-muted [a&]:hover:text-muted-foreground",
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
