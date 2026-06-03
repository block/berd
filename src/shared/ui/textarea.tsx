import type * as React from "react";

import { cn } from "@/shared/lib/cn";
import { getDesignSystemMetadata } from "@/shared/ui/design-system/metadata";

type TextareaProps = React.ComponentProps<"textarea"> & {
  variant?: "default" | "code";
};

function Textarea({ className, variant = "default", ...props }: TextareaProps) {
  return (
    <textarea
      {...getDesignSystemMetadata({
        component: "Textarea",
        slot: "textarea",
        source: "src/shared/ui/textarea.tsx",
        props: {
          disabled: props.disabled,
          invalid: props["aria-invalid"],
          variant,
        },
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="textarea"
      className={cn(
        "border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-0 focus-visible:ring-offset-0 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive flex field-sizing-content min-h-16 w-full rounded-sm border bg-transparent px-3 py-2 text-base transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        variant === "code" && "font-mono text-xs md:text-xs",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
