import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronDown } from "@tabler/icons-react";
import { CheckIcon } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { cn } from "@/shared/lib/cn";
import { PILL_TONES, type PillTone, isPillTone } from "../lib/pillTones";

interface ProjectColorPickerProps {
  /** Current stored color (tone name; legacy hex tolerated, treated as
   * "unselected"). */
  value: string;
  onChange: (tone: PillTone) => void;
  variant?: "popover" | "swatches";
  className?: string;
}

/**
 * Pill-shaped popover trigger ("Choose a project color" + chevron) that
 * opens a tray of pastel tone swatches. Selecting a swatch closes the
 * popover and calls onChange with the tone name.
 */
export function ProjectColorPicker({
  value,
  onChange,
  variant = "popover",
  className,
}: ProjectColorPickerProps) {
  const { t } = useTranslation(["projects"]);
  const [open, setOpen] = useState(false);
  const selected = isPillTone(value) ? value : null;
  const label = t("dialog.chooseColor");

  if (variant === "swatches") {
    return (
      <fieldset
        aria-label={label}
        className={cn("relative inline-flex border-0 p-0", className)}
      >
        <div className="inline-flex h-10 items-center gap-2 rounded-full bg-white/95 px-2.5 shadow-[0_10px_26px_rgba(15,23,42,0.12)] backdrop-blur-md">
          {PILL_TONES.map((tone) => (
            <button
              type="button"
              key={tone}
              aria-label={t("dialog.colorAria", { color: tone })}
              aria-pressed={selected === tone}
              onClick={() => onChange(tone)}
              className={cn(
                "inline-flex size-5 items-center justify-center rounded-full border border-[#242424]/15 text-[#666666] transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#666666]/35",
                `bg-pill-${tone}`,
                selected === tone &&
                  "scale-110 border-[#666666] ring-2 ring-[#666666]/55 ring-offset-2 ring-offset-white",
              )}
            >
              {selected === tone ? (
                <CheckIcon className="size-3 stroke-[3]" aria-hidden="true" />
              ) : null}
            </button>
          ))}
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
        <div className="flex items-center gap-1.5">
          {PILL_TONES.map((tone) => (
            <button
              type="button"
              key={tone}
              aria-label={t("dialog.colorAria", { color: tone })}
              aria-pressed={selected === tone}
              onClick={() => {
                onChange(tone);
                setOpen(false);
              }}
              className={cn(
                "inline-flex size-4 items-center justify-center rounded-full border border-[#242424]/15 text-[#666666] transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#666666]/35",
                `bg-pill-${tone}`,
                selected === tone &&
                  "border-[#666666] ring-2 ring-[#666666]/55",
              )}
            >
              {selected === tone ? (
                <CheckIcon className="size-2.5 stroke-[3]" aria-hidden="true" />
              ) : null}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
