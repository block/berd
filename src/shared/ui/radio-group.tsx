import type * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { CircleIcon } from "lucide-react";

import { cn } from "@/shared/lib/cn";

function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("grid gap-3", className)}
      {...props}
    />
  );
}

function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "border-input text-primary-foreground data-[state=checked]:bg-primary data-[state=checked]:border-none focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive aspect-square size-4 shrink-0 rounded-full border transition-[color,box-shadow] outline-none focus-visible:ring-[1px] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="relative flex items-center justify-center"
      >
        <CircleIcon className="fill-background absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

type RadioGroupCardProps = Omit<
  React.ComponentProps<"label">,
  "children" | "htmlFor"
> & {
  id: string;
  value: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
};

function RadioGroupCard({
  id,
  value,
  label,
  description,
  disabled = false,
  className,
  ...props
}: RadioGroupCardProps) {
  const labelId = `${id}-label`;
  const descriptionId = description ? `${id}-description` : undefined;

  return (
    <label
      data-slot="radio-group-card"
      htmlFor={id}
      className={cn(
        "has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-muted has-[[data-slot=radio-group-item]:focus-visible]:border-ring has-[[data-slot=radio-group-item]:focus-visible]:ring-ring/50 flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-3 transition-[color,box-shadow] outline-none hover:bg-muted/50 has-[[data-slot=radio-group-item]:focus-visible]:ring-[3px] has-[[data-slot=radio-group-item][data-disabled]]:cursor-not-allowed has-[[data-slot=radio-group-item][data-disabled]]:opacity-50 has-[[data-slot=radio-group-item][data-disabled][data-state=unchecked]]:hover:bg-transparent has-[[data-slot=radio-group-item][data-disabled][data-state=checked]]:hover:bg-muted",
        className,
      )}
      {...props}
    >
      <RadioGroupItem
        id={id}
        value={value}
        disabled={disabled}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        className="mt-0.5 focus-visible:border-transparent focus-visible:ring-0 disabled:opacity-100"
      />
      <span className="min-w-0">
        <span
          id={labelId}
          data-slot="radio-group-card-label"
          className="block text-sm font-medium"
        >
          {label}
        </span>
        {description ? (
          <span
            id={descriptionId}
            data-slot="radio-group-card-description"
            className="mt-1 block text-xs leading-relaxed text-muted-foreground"
          >
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export { RadioGroup, RadioGroupCard, RadioGroupItem };
