import type { ReactNode } from "react";

import { cn } from "@/shared/lib/cn";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { Switch } from "@/shared/ui/switch";

type SelectControl = {
  id: string;
  label: string;
  type: "select";
  value: string;
  disabled?: boolean;
  options: Array<{ label: string; value: string }>;
  onChange: (value: string) => void;
};

type TextControl = {
  id: string;
  label: string;
  type: "text";
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
};

type SwitchControl = {
  id: string;
  label: string;
  type: "switch";
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
};

export type PlaygroundControl = SelectControl | TextControl | SwitchControl;

export function ComponentPlayground({
  title = "Playground",
  description,
  preview,
  controls,
  details,
  fullWidthPreview = false,
  previewCaption,
}: {
  title?: string;
  description?: string;
  preview: ReactNode;
  controls: PlaygroundControl[];
  details?: ReactNode;
  fullWidthPreview?: boolean;
  previewCaption?: ReactNode;
}) {
  return (
    <section className="rounded-md border border-border bg-background px-4 py-4">
      <div className="mb-4">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {description ? (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>

      <div
        className={cn(
          "grid overflow-hidden rounded-md border border-border bg-background",
          !fullWidthPreview && "md:grid-cols-[minmax(0,1fr)_280px]",
        )}
      >
        <div
          className={cn(
            "min-h-52",
            !fullWidthPreview && "flex items-center justify-center p-6",
          )}
        >
          {preview}
        </div>

        {!fullWidthPreview ? (
          <div className="border-t border-border bg-background p-3 md:border-t-0 md:border-l">
            <div className="grid gap-3">
              {controls.map((control) => (
                <PlaygroundControlField key={control.id} control={control} />
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {previewCaption ? <div className="mt-3">{previewCaption}</div> : null}

      {details ? (
        <div className={previewCaption ? "mt-8" : "mt-4"}>{details}</div>
      ) : null}
    </section>
  );
}

function PlaygroundControlField({ control }: { control: PlaygroundControl }) {
  const controlId = `design-system-control-${control.id}`;

  if (control.type === "select") {
    return (
      <div className="grid gap-1.5">
        <Label
          htmlFor={controlId}
          className="text-xs font-medium text-muted-foreground"
        >
          {control.label}
        </Label>
        <Select
          value={control.value}
          onValueChange={control.onChange}
          disabled={control.disabled}
        >
          <SelectTrigger
            id={controlId}
            className="w-full"
            size="sm"
            disabled={control.disabled}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {control.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (control.type === "text") {
    return (
      <div className="grid gap-1.5">
        <Label
          htmlFor={controlId}
          className={cn(
            "text-xs font-medium text-muted-foreground",
            control.disabled && "opacity-50",
          )}
        >
          {control.label}
        </Label>
        <Input
          id={controlId}
          value={control.value}
          disabled={control.disabled}
          onChange={(event) => control.onChange(event.target.value)}
        />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2">
      <Label
        htmlFor={controlId}
        className={cn(
          "text-xs font-medium text-muted-foreground",
          control.disabled && "opacity-50",
        )}
      >
        {control.label}
      </Label>
      <Switch
        id={controlId}
        checked={control.checked}
        disabled={control.disabled}
        onCheckedChange={control.onChange}
      />
    </div>
  );
}
