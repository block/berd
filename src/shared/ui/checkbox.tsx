import type * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { CheckIcon } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { getDesignSystemMetadata } from "@/shared/ui/design-system/metadata";

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      {...getDesignSystemMetadata({
        component: "Checkbox",
        slot: "checkbox",
        source: "src/shared/ui/checkbox.tsx",
        props: {
          checked:
            props.checked === "indeterminate" ? "indeterminate" : props.checked,
          disabled: props.disabled,
        },
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="checkbox"
      className={cn(
        "peer border-input data-[state=checked]:bg-background-primary data-[state=checked]:text-text-on-primary data-[state=checked]:border-border-inverse focus-visible:border-border-focus focus-visible:ring-ring-focus/50 aria-invalid:ring-border-danger/20 aria-invalid:border-border-danger size-4 shrink-0 rounded-[4px] border transition-shadow outline-none focus-visible:ring-[1px] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current transition-none"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
