import type * as React from "react";

import { cn } from "@/shared/lib/cn";
import { getDesignSystemMetadata } from "@/shared/ui/design-system/metadata";

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      {...getDesignSystemMetadata({
        component: "Card",
        slot: "card",
        source: "src/shared/ui/card.tsx",
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="card"
      className={cn(
        "flex flex-col gap-6 rounded-card border border-border-card bg-background-card py-6 text-text-on-card transition-shadow hover:shadow-card",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      {...getDesignSystemMetadata({
        component: "Card",
        slot: "card-header",
        source: "src/shared/ui/card.tsx",
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      {...getDesignSystemMetadata({
        component: "Card",
        slot: "card-title",
        source: "src/shared/ui/card.tsx",
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="card-title"
      className={cn(
        "font-display font-semibold leading-none tracking-[-0.01em]",
        className,
      )}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      {...getDesignSystemMetadata({
        component: "Card",
        slot: "card-description",
        source: "src/shared/ui/card.tsx",
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="card-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      {...getDesignSystemMetadata({
        component: "Card",
        slot: "card-action",
        source: "src/shared/ui/card.tsx",
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className,
      )}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      {...getDesignSystemMetadata({
        component: "Card",
        slot: "card-content",
        source: "src/shared/ui/card.tsx",
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="card-content"
      className={cn("px-6", className)}
      {...props}
    />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      {...getDesignSystemMetadata({
        component: "Card",
        slot: "card-footer",
        source: "src/shared/ui/card.tsx",
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="card-footer"
      className={cn("flex items-center px-6 [.border-t]:pt-6", className)}
      {...props}
    />
  );
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
};
