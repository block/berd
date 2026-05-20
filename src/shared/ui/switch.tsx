import type * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "@/shared/lib/cn";
import { getDesignSystemMetadata } from "@/shared/ui/design-system/metadata";

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      {...getDesignSystemMetadata({
        component: "Switch",
        slot: "switch",
        source: "src/shared/ui/switch.tsx",
        props: {
          checked: props.checked,
          disabled: props.disabled,
        },
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="switch"
      className={cn(
        "peer data-[state=checked]:bg-background-primary data-[state=unchecked]:bg-background-medium focus-visible:border-border-focus focus-visible:ring-ring-focus/50 inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent transition-all outline-none focus-visible:ring-[1px] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "bg-text-on-primary pointer-events-none block size-4 rounded-full ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
