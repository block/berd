import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronDown } from "@tabler/icons-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { cn } from "@/shared/lib/cn";
import { PILL_TONES, type PillTone, isPillTone } from "../lib/pillTones";

interface ProjectColorPickerProps {
  /** Current stored color (tone name; legacy hex tolerated, treated as
   * "unselected"). */
  value: string;
  onChange: (tone: PillTone) => void;
}

/**
 * Pill-shaped popover trigger ("Choose a project color" + chevron) that
 * opens a tray of pastel tone swatches. Selecting a swatch closes the
 * popover and calls onChange with the tone name.
 */
export function ProjectColorPicker({
  value,
  onChange,
}: ProjectColorPickerProps) {
  const { t } = useTranslation(["projects"]);
  const [open, setOpen] = useState(false);
  const selected = isPillTone(value) ? value : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-full bg-foreground px-2.5 pb-[3px] pt-[2px] text-[11px] text-background"
        >
          {t("dialog.chooseColor")}
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
                "size-4 rounded-full transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30",
                `bg-pill-${tone}`,
                selected === tone && "ring-2 ring-foreground/60",
              )}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
