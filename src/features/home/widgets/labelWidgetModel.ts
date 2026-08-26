import type React from "react";
import type { WidgetSize } from "./types";

export const LABEL_DEFAULT_SIZE: WidgetSize = { width: 280, height: 56 };
export const LABEL_FONT_SIZE_MIN_PX = 8;
export const LABEL_FONT_SIZE_MAX_PX = 72;
export const LABEL_FONT_SIZE_DEFAULT_PX = 18;
export const LABEL_FONT_SIZE_LARGE_STEP_PX = 4;

export const LABEL_FONT_FAMILIES = [
  "sans",
  "serif",
  "mono",
  "comic",
  "marker",
] as const;
export type LabelFontFamily = (typeof LABEL_FONT_FAMILIES)[number];
export const LABEL_FONT_FAMILY_DEFAULT: LabelFontFamily = "sans";

export function labelFontFamily(
  state: Record<string, unknown> | undefined,
): LabelFontFamily {
  const value = state?.fontFamily;
  return LABEL_FONT_FAMILIES.includes(value as LabelFontFamily)
    ? (value as LabelFontFamily)
    : LABEL_FONT_FAMILY_DEFAULT;
}

export function labelFontFamilyStyle(
  fontFamily: LabelFontFamily,
): React.CSSProperties {
  switch (fontFamily) {
    case "serif":
      return { fontFamily: "var(--font-label-serif)" };
    case "mono":
      return { fontFamily: "var(--font-mono)" };
    case "comic":
      return { fontFamily: "var(--font-label-comic)" };
    case "marker":
      return { fontFamily: "var(--font-label-marker)" };
    default:
      return { fontFamily: "var(--font-sans)" };
  }
}

export function labelFontSizePx(
  state: Record<string, unknown> | undefined,
): number {
  const value = state?.fontSizePx;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(LABEL_FONT_SIZE_MAX_PX, Math.max(LABEL_FONT_SIZE_MIN_PX, value))
    : LABEL_FONT_SIZE_DEFAULT_PX;
}
