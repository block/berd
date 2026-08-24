import type { WidgetSize } from "./types";

export const LABEL_DEFAULT_SIZE: WidgetSize = { width: 280, height: 56 };
export const LABEL_FONT_SIZE_MIN_PX = 8;
export const LABEL_FONT_SIZE_MAX_PX = 72;
export const LABEL_FONT_SIZE_DEFAULT_PX = 18;
export const LABEL_FONT_SIZE_LARGE_STEP_PX = 4;

export function labelFontSizePx(
  state: Record<string, unknown> | undefined,
): number {
  const value = state?.fontSizePx;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(LABEL_FONT_SIZE_MAX_PX, Math.max(LABEL_FONT_SIZE_MIN_PX, value))
    : LABEL_FONT_SIZE_DEFAULT_PX;
}
