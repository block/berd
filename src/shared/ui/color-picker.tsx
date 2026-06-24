import { forwardRef, useId, useState } from "react";
import type { ButtonHTMLAttributes, CSSProperties, ReactElement } from "react";
import { CheckIcon, PlusIcon } from "lucide-react";

import { Input } from "@/shared/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { cn } from "@/shared/lib/cn";

export interface ColorSwatch {
  /** Identifier stored/returned via onChange, e.g. a tone name or hex string. */
  id: string;
  /** Accessible label for the swatch button. */
  label: string;
  /** CSS class applied to the swatch, e.g. `bg-pill-pink`. */
  className?: string;
  /** Inline background color used when `className` is not provided. */
  color?: string;
}

export interface ColorPickerProps {
  /** Current stored value: a preset id or custom hex string. */
  value: string;
  onChange: (value: string) => void;
  presets?: ColorSwatch[];
  variant?: "popover" | "swatches";
  swatchSize?: "sm" | "md";
  label?: string;
  triggerLabel?: string;
  className?: string;
  customColorMode?: "pastel" | "none";
  customColorLabel?: string;
  hueLabel?: string;
  hexLabel?: string;
}

const PASTEL_SATURATION = 52;
const PASTEL_LIGHTNESS = 82;
const DEFAULT_HUE = 84;

export function isHexColor(value: string | null | undefined): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function normalizeHex(value: string): string | null {
  const trimmed = value.trim();
  const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex
      .split("")
      .map((c) => c + c)
      .join("")
      .toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return `#${hex.toLowerCase()}`;
  }
  return null;
}

function hexToHue(hex: string): number {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return DEFAULT_HUE;
  const r = Number.parseInt(match[1], 16) / 255;
  const g = Number.parseInt(match[2], 16) / 255;
  const b = Number.parseInt(match[3], 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return DEFAULT_HUE;
  let hue: number;
  if (max === r) {
    hue = ((g - b) / delta) % 6;
  } else if (max === g) {
    hue = (b - r) / delta + 2;
  } else {
    hue = (r - g) / delta + 4;
  }
  return Math.round((hue * 60 + 360) % 360);
}

function hueToHex(hue: number, saturation: number, lightness: number): string {
  const h = (((hue % 360) + 360) % 360) / 360;
  const s = saturation / 100;
  const l = lightness / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = hueChannel(p, q, h + 1 / 3);
  const g = hueChannel(p, q, h);
  const b = hueChannel(p, q, h - 1 / 3);
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hueChannel(p: number, q: number, t: number): number {
  let next = t;
  if (next < 0) next += 1;
  if (next > 1) next -= 1;
  if (next < 1 / 6) return p + (q - p) * 6 * next;
  if (next < 1 / 2) return q;
  if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6;
  return p;
}

function toHex(value: number): string {
  return Math.round(value * 255)
    .toString(16)
    .padStart(2, "0");
}

function hexFromHue(mode: "pastel" | "none", hue: number): string {
  if (mode === "pastel") {
    return hueToHex(hue, PASTEL_SATURATION, PASTEL_LIGHTNESS);
  }
  return hueToHex(hue, 70, 55);
}

function swatchIconColor(hex: string): string {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return "var(--muted-foreground)";
  const r = Number.parseInt(match[1], 16);
  const g = Number.parseInt(match[2], 16);
  const b = Number.parseInt(match[3], 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? "var(--color-gray-800)" : "var(--color-white)";
}

function normalizeCustomColor(
  color: string,
  mode: "pastel" | "none",
): string | null {
  if (!isHexColor(color)) return null;
  return mode === "pastel"
    ? hexFromHue("pastel", hexToHue(color))
    : color.toLowerCase();
}

export function ColorPicker({
  value,
  onChange,
  presets = [],
  variant = "popover",
  swatchSize = variant === "swatches" ? "md" : "sm",
  label = "Choose a color",
  triggerLabel,
  className,
  customColorMode = "none",
  customColorLabel = "Custom color",
  hueLabel = "Hue",
  hexLabel = "Hex",
}: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customHue, setCustomHue] = useState(() => hexToHue(value));
  const [customHex, setCustomHex] = useState(() =>
    isHexColor(value) ? value : hexFromHue(customColorMode, hexToHue(value)),
  );

  const selectedPreset = presets.find((preset) => preset.id === value);
  const isCustom = !selectedPreset && isHexColor(value);

  const updateCustomColor = (color: string) => {
    const normalized = normalizeCustomColor(color, customColorMode);
    if (!normalized) return;
    setCustomHex(normalized);
    setCustomHue(hexToHue(normalized));
    onChange(normalized);
  };

  const prepareCustomPicker = () => {
    const hex = isCustom ? value : hexFromHue(customColorMode, customHue);
    setCustomHex(hex);
    setCustomHue(hexToHue(hex));
  };

  const updateCustomHue = (nextHue: number) => {
    const hex = hexFromHue(customColorMode, nextHue);
    setCustomHue(nextHue);
    setCustomHex(hex);
    onChange(hex);
  };

  const updateCustomHex = (nextHex: string) => {
    setCustomHex(nextHex);
    updateCustomColor(nextHex);
  };

  const applyPresetColor = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  const swatches = (
    <>
      {presets.map((preset) => (
        <SwatchButton
          key={preset.id}
          label={preset.label}
          selected={selectedPreset?.id === preset.id}
          className={preset.className}
          style={
            preset.color
              ? {
                  backgroundColor: preset.color,
                  color: swatchIconColor(preset.color),
                }
              : undefined
          }
          onClick={() => applyPresetColor(preset.id)}
          size={swatchSize}
        />
      ))}
      <CustomColorPopover
        open={customOpen}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            prepareCustomPicker();
          }
          setCustomOpen(nextOpen);
        }}
        trigger={
          <SwatchButton
            label={customColorLabel}
            selected={isCustom}
            size={swatchSize}
            style={
              isCustom
                ? {
                    backgroundColor: value,
                    color: swatchIconColor(value),
                  }
                : undefined
            }
            icon={isCustom ? "check" : "plus"}
          />
        }
        hue={customHue}
        hex={customHex}
        onHueChange={updateCustomHue}
        onHexChange={updateCustomHex}
        onHexBlur={(nextHex) => {
          const normalized = normalizeHex(nextHex);
          if (normalized) {
            updateCustomColor(normalized);
          }
        }}
        heading={customColorLabel}
        hueLabel={hueLabel}
        hexLabel={hexLabel}
      />
    </>
  );

  if (variant === "swatches") {
    return (
      <fieldset
        aria-label={label}
        className={cn("relative inline-flex border-0 p-0", className)}
      >
        <div
          className={cn(
            "inline-flex items-center rounded-full bg-[var(--surface-color-picker-swatches)] shadow-[var(--shadow-color-picker-swatches)] backdrop-blur-md",
            swatchSize === "md" ? "h-10 gap-2 px-2.5" : "h-8 gap-1.5 px-2",
          )}
        >
          {swatches}
        </div>
      </fieldset>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {triggerLabel ? (
          <button
            type="button"
            aria-label={label}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full bg-foreground px-2.5 pb-[3px] pt-[2px] text-[11px] text-background",
              className,
            )}
          >
            {triggerLabel}
            <ChevronDownIcon />
          </button>
        ) : (
          <button
            type="button"
            aria-label={label}
            className={cn(
              "inline-flex h-9 w-12 cursor-pointer items-center justify-center rounded-md border border-border bg-background p-1",
              className,
            )}
          >
            <span
              className="h-full w-full rounded-md"
              style={{ backgroundColor: isHexColor(value) ? value : undefined }}
            />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-auto rounded-sm p-1.5"
      >
        <div className="flex items-center gap-1.5">{swatches}</div>
      </PopoverContent>
    </Popover>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      className="size-2.5"
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

interface SwatchButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  label: string;
  selected: boolean;
  className?: string;
  style?: CSSProperties;
  size: "sm" | "md";
  icon?: "check" | "plus";
}

const SwatchButton = forwardRef<HTMLButtonElement, SwatchButtonProps>(
  (
    { label, selected, className, style, size, icon = "check", ...props },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-pressed={selected}
        className={cn(
          "inline-flex items-center justify-center rounded-full border border-foreground/15 text-muted-foreground transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-muted-foreground/35",
          size === "md" ? "size-5" : "size-4",
          !className && !style && "bg-background",
          className,
          selected &&
            (size === "md"
              ? "scale-110 border-muted-foreground ring-2 ring-muted-foreground/55 ring-offset-2 ring-offset-background"
              : "border-muted-foreground ring-2 ring-muted-foreground/55"),
        )}
        style={style}
        {...props}
      >
        {selected ? (
          <CheckIcon
            className={cn(size === "md" ? "size-3" : "size-2.5", "stroke-[3]")}
            aria-hidden="true"
          />
        ) : icon === "plus" ? (
          <PlusIcon
            className={cn(
              size === "md" ? "size-3" : "size-2.5",
              "stroke-[2.8]",
            )}
            aria-hidden="true"
          />
        ) : null}
      </button>
    );
  },
);
SwatchButton.displayName = "SwatchButton";

function CustomColorPopover({
  open,
  onOpenChange,
  trigger,
  hue,
  hex,
  onHueChange,
  onHexChange,
  onHexBlur,
  heading,
  hueLabel,
  hexLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement;
  hue: number;
  hex: string;
  onHueChange: (hue: number) => void;
  onHexChange: (hex: string) => void;
  onHexBlur: (hex: string) => void;
  heading: string;
  hueLabel: string;
  hexLabel: string;
}) {
  const hueInputId = useId();
  const hexInputId = useId();

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={12}
        avoidCollisions={false}
        className="z-[70] w-[320px] gap-5 rounded-lg bg-popover p-5 shadow-[var(--shadow-modal)]"
      >
        <h2 className="text-sm font-normal tracking-normal text-foreground">
          {heading}
        </h2>
        <div className="mt-5 space-y-4">
          <label htmlFor={hueInputId} className="block space-y-2">
            <span className="text-[10px] leading-3 text-foreground/45">
              {hueLabel}
            </span>
            <input
              id={hueInputId}
              type="range"
              min={0}
              max={359}
              value={hue}
              onChange={(event) => onHueChange(Number(event.target.value))}
              className="h-3 w-full cursor-pointer appearance-none rounded-full bg-[image:var(--color-picker-hue-gradient)] accent-muted-foreground"
            />
          </label>
          <label htmlFor={hexInputId} className="block space-y-2">
            <span className="text-[10px] leading-3 text-foreground/45">
              {hexLabel}
            </span>
            <Input
              id={hexInputId}
              value={hex}
              onChange={(event) => onHexChange(event.target.value)}
              onBlur={(event) => onHexBlur(event.target.value)}
              className="h-10 rounded-sm border-0 bg-accent px-3 font-mono text-editor-mono uppercase text-foreground shadow-none focus-visible:ring-muted-foreground/35"
            />
          </label>
        </div>
      </PopoverContent>
    </Popover>
  );
}
