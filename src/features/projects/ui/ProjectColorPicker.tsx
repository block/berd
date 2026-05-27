import { forwardRef, useId, useState } from "react";
import type { ButtonHTMLAttributes, CSSProperties, ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronDown } from "@tabler/icons-react";
import { CheckIcon, PlusIcon } from "lucide-react";

import { Input } from "@/shared/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { cn } from "@/shared/lib/cn";
import {
  customPillColorFromHue,
  hueFromCustomColor,
  isHexColor,
  normalizeCustomPillColor,
} from "../lib/customPillColor";
import { PILL_TONES, isPillTone } from "../lib/pillTones";

interface ProjectColorPickerProps {
  /** Current stored color: a preset tone name or normalized custom hex. */
  value: string;
  onChange: (color: string) => void;
  variant?: "popover" | "swatches";
  className?: string;
}

export function ProjectColorPicker({
  value,
  onChange,
  variant = "popover",
  className,
}: ProjectColorPickerProps) {
  const { t } = useTranslation(["projects"]);
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customHue, setCustomHue] = useState(() => hueFromCustomColor(value));
  const [customHex, setCustomHex] = useState(() =>
    normalizeCustomPillColor(value),
  );
  const selected = isPillTone(value) ? value : null;
  const selectedCustom = isHexColor(value) ? value : null;
  const label = t("dialog.chooseColor");

  const prepareCustomPicker = () => {
    const hex = selectedCustom ?? customPillColorFromHue(customHue);
    setCustomHex(hex);
    setCustomHue(hueFromCustomColor(hex));
  };

  const updateCustomHue = (nextHue: number) => {
    const normalized = customPillColorFromHue(nextHue);
    setCustomHue(nextHue);
    setCustomHex(normalized);
    onChange(normalized);
  };

  const updateCustomHex = (nextHex: string) => {
    setCustomHex(nextHex);
    if (isHexColor(nextHex)) {
      const normalized = normalizeCustomPillColor(nextHex);
      setCustomHex(normalized);
      setCustomHue(hueFromCustomColor(normalized));
      onChange(normalized);
    }
  };

  const applyPresetColor = (tone: string) => {
    onChange(tone);
    setOpen(false);
  };

  const swatches = (
    <>
      {PILL_TONES.map((tone) => (
        <SwatchButton
          key={tone}
          label={t("dialog.colorAria", { color: tone })}
          selected={selected === tone}
          className={`bg-pill-${tone}`}
          onClick={() => applyPresetColor(tone)}
          size={variant === "swatches" ? "md" : "sm"}
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
            label={t("dialog.customColor")}
            selected={Boolean(selectedCustom)}
            size={variant === "swatches" ? "md" : "sm"}
            style={
              selectedCustom ? { backgroundColor: selectedCustom } : undefined
            }
            icon={selectedCustom ? "check" : "plus"}
          />
        }
        hue={customHue}
        hex={customHex}
        onHueChange={updateCustomHue}
        onHexChange={updateCustomHex}
      />
    </>
  );

  if (variant === "swatches") {
    return (
      <fieldset
        aria-label={label}
        className={cn("relative inline-flex border-0 p-0", className)}
      >
        <div className="inline-flex h-10 items-center gap-2 rounded-full bg-white/95 px-2.5 shadow-[0_10px_26px_rgba(15,23,42,0.12)] backdrop-blur-md">
          {swatches}
        </div>
      </fieldset>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-full bg-foreground px-2.5 pb-[3px] pt-[2px] text-[11px] text-background",
            className,
          )}
        >
          {label}
          <IconChevronDown className="size-2.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-auto rounded-full p-1.5"
      >
        <div className="flex items-center gap-1.5">{swatches}</div>
      </PopoverContent>
    </Popover>
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
          "inline-flex items-center justify-center rounded-full border border-[#242424]/15 text-[#666666] transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#666666]/35",
          size === "md" ? "size-5" : "size-4",
          !className && "bg-white",
          className,
          selected &&
            (size === "md"
              ? "scale-110 border-[#666666] ring-2 ring-[#666666]/55 ring-offset-2 ring-offset-white"
              : "border-[#666666] ring-2 ring-[#666666]/55"),
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement;
  hue: number;
  hex: string;
  onHueChange: (hue: number) => void;
  onHexChange: (hex: string) => void;
}) {
  const { t } = useTranslation(["projects"]);
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
        className="z-[70] w-[320px] gap-5 rounded-[24px] bg-white p-5 shadow-[0_22px_72px_rgba(15,23,42,0.18)]"
      >
        <h2 className="text-sm font-normal tracking-normal text-[#242424]">
          {t("dialog.customColor")}
        </h2>
        <div className="mt-5 space-y-4">
          <label htmlFor={hueInputId} className="block space-y-2">
            <span className="text-[10px] leading-3 text-[#242424]/45">
              {t("dialog.hue")}
            </span>
            <input
              id={hueInputId}
              type="range"
              min={0}
              max={359}
              value={hue}
              onChange={(event) => onHueChange(Number(event.target.value))}
              className="h-3 w-full cursor-pointer appearance-none rounded-full bg-[linear-gradient(90deg,#eeb4b4,#eeeeae,#b4eed0,#b4d0ee,#d0b4ee,#eeb4d2,#eeb4b4)] accent-[#666666]"
            />
          </label>
          <label htmlFor={hexInputId} className="block space-y-2">
            <span className="text-[10px] leading-3 text-[#242424]/45">
              {t("dialog.hex")}
            </span>
            <Input
              id={hexInputId}
              value={hex}
              onChange={(event) => onHexChange(event.target.value)}
              onBlur={(event) =>
                onHexChange(normalizeCustomPillColor(event.target.value))
              }
              className="h-10 rounded-[12px] border-0 bg-[#f5f5f5] px-3 font-mono text-[13px] uppercase text-[#242424] shadow-none focus-visible:ring-[#666666]/35"
            />
          </label>
        </div>
      </PopoverContent>
    </Popover>
  );
}
