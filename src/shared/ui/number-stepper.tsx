import { Minus, Plus } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { getDesignSystemMetadata } from "@/shared/ui/design-system/metadata";

interface NumberStepperProps {
  value: number;
  onValueChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  largeStep?: number;
  label: string;
  decrementLabel: string;
  incrementLabel: string;
  unit?: string;
  disabled?: boolean;
  className?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function NumberStepper({
  value,
  onValueChange,
  min,
  max,
  step = 1,
  largeStep = step * 10,
  label,
  decrementLabel,
  incrementLabel,
  unit,
  disabled = false,
  className,
}: NumberStepperProps) {
  const inputId = useId();
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const parsedDraft = Number(draft);
  const draftIsValid = draft.trim() !== "" && Number.isFinite(parsedDraft);

  const commit = (candidate = draft) => {
    const parsed = Number(candidate);
    if (candidate.trim() === "" || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = clamp(Math.round(parsed), min, max);
    setDraft(String(next));
    if (next !== value) onValueChange(next);
  };

  const changeBy = (delta: number) => {
    const base = draftIsValid ? parsedDraft : value;
    commit(String(base + delta));
  };

  return (
    <div
      {...getDesignSystemMetadata({
        component: "NumberStepper",
        slot: "root",
        source: "src/shared/ui/number-stepper.tsx",
        props: { disabled },
        customClassName: className,
      })}
      role="group"
      aria-label={label}
      className={cn(
        "flex h-7 shrink-0 items-center overflow-hidden rounded-full border border-border bg-background text-foreground",
        className,
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={decrementLabel}
        disabled={disabled || value <= min}
        onClick={() => changeBy(-step)}
      >
        <Minus aria-hidden="true" />
      </Button>
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <input
        id={inputId}
        type="text"
        role="spinbutton"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={
          draftIsValid ? clamp(Math.round(parsedDraft), min, max) : undefined
        }
        aria-valuetext={
          draftIsValid
            ? `${clamp(Math.round(parsedDraft), min, max)}${unit ? ` ${unit}` : ""}`
            : undefined
        }
        disabled={disabled}
        value={draft}
        onChange={(event) => {
          if (/^-?\d*$/.test(event.target.value)) setDraft(event.target.value);
        }}
        onBlur={() => commit()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const direction = event.key === "ArrowUp" ? 1 : -1;
            changeBy(direction * (event.shiftKey ? largeStep : step));
          } else if (event.key === "Enter") {
            event.preventDefault();
            commit();
            event.currentTarget.select();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(String(value));
            event.currentTarget.select();
          } else if (event.key === "Home") {
            event.preventDefault();
            commit(String(min));
          } else if (event.key === "End") {
            event.preventDefault();
            commit(String(max));
          }
        }}
        className="h-7 w-10 border-x border-border bg-background px-1 text-center text-xs font-medium tabular-nums text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={incrementLabel}
        disabled={disabled || value >= max}
        onClick={() => changeBy(step)}
      >
        <Plus aria-hidden="true" />
      </Button>
    </div>
  );
}
