import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/cn";
import { getDesignSystemMetadata } from "@/shared/ui/design-system/metadata";

const alertVariants = cva(
  "relative w-full rounded-md border px-4 py-3 text-sm grid has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] grid-cols-[0_1fr] has-[>svg]:gap-x-3 gap-y-0.5 items-start [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default: "border-border bg-background text-foreground",
        destructive:
          "border-border bg-background text-destructive [&>svg]:text-current *:data-[slot=alert-description]:text-destructive/90",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      {...getDesignSystemMetadata({
        component: "Alert",
        slot: "alert",
        source: "src/shared/ui/alert.tsx",
        variant: variant ?? "default",
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      {...getDesignSystemMetadata({
        component: "Alert",
        slot: "alert-title",
        source: "src/shared/ui/alert.tsx",
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="alert-title"
      className={cn(
        "font-display col-start-2 line-clamp-1 min-h-4 font-semibold tracking-[-0.01em]",
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      {...getDesignSystemMetadata({
        component: "Alert",
        slot: "alert-description",
        source: "src/shared/ui/alert.tsx",
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="alert-description"
      className={cn(
        "text-muted-foreground col-start-2 grid justify-items-start gap-1 text-sm [&_p]:leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };
