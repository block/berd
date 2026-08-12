/**
 * Pill tones — the canonical palette for project colors and skill pills.
 *
 * Source of truth lives in `src/shared/styles/globals.css` as the
 * `--color-pill-*` custom properties (which Tailwind v4 also exposes as
 * `bg-pill-*` utilities). This module re-exposes the same names so feature
 * code can render a swatch grid or look up the CSS color value of a stored
 * tone without re-declaring the palette.
 *
 * Storage convention: `ProjectInfo.color` stores the tone NAME (e.g. "pink").
 * Consumers map to a Tailwind class via `pillBgClass(tone)` or to a CSS
 * color string via `pillCssColor(tone)` — which returns the `var(...)`
 * reference, not a literal hex, so the stylesheet stays the single source
 * of truth. Legacy hex strings stored before the tone migration fall back
 * to `null` from `pillCssColor` — callers must handle that gracefully.
 */
export const PILL_TONES = [
  "pink",
  "lavender",
  "blue",
  "sage",
  "olive",
  "mint",
  "peach",
] as const;

export type PillTone = (typeof PILL_TONES)[number];

export function isPillTone(value: string): value is PillTone {
  return (PILL_TONES as readonly string[]).includes(value);
}

/** Returns the `bg-pill-{tone}` Tailwind utility for a stored color string,
 *  or `null` if the value is not a known tone (e.g. legacy hex). */
export function pillBgClass(value: string): string | null {
  return isPillTone(value) ? `bg-pill-${value}` : null;
}

/** Returns a CSS color string for a stored tone, or `null` if the value is
 *  not a known tone. Resolves to the live `--color-pill-{tone}` variable so
 *  the stylesheet remains the single source of truth — no JS-side hex map. */
export function pillCssColor(value: string): string | null {
  return isPillTone(value) ? `var(--color-pill-${value})` : null;
}
