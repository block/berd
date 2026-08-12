import { useTranslation } from "react-i18next";

import { ColorPicker } from "@/shared/ui/color-picker";
import type { ColorSwatch } from "@/shared/ui/color-picker";
import { PILL_TONES } from "../lib/pillTones";

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
  const label = t("dialog.chooseColor");

  const presets: ColorSwatch[] = PILL_TONES.map((tone) => ({
    id: tone,
    label: t("dialog.colorAria", { color: tone }),
    className: `bg-pill-${tone}`,
  }));

  return (
    <ColorPicker
      value={value}
      onChange={onChange}
      presets={presets}
      variant={variant}
      label={label}
      triggerLabel={variant === "popover" ? label : undefined}
      className={className}
      customColorMode="pastel"
      customColorLabel={t("dialog.customColor")}
      hueLabel={t("dialog.hue")}
      hexLabel={t("dialog.hex")}
    />
  );
}
