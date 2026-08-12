import type * as React from "react";

import { cn } from "@/shared/lib/cn";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border bg-background px-1 font-sans text-xs text-muted-foreground shadow-kbd",
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };
