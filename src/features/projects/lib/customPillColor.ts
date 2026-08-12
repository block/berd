const PASTEL_SATURATION = 52;
const PASTEL_LIGHTNESS = 82;
const DEFAULT_HUE = 84;

export function isHexColor(value: string | null | undefined): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function normalizeCustomPillColor(value: string): string {
  const rgb = parseHexColor(value);
  if (!rgb) {
    return hslToHex(DEFAULT_HUE, PASTEL_SATURATION, PASTEL_LIGHTNESS);
  }
  const hue = rgbToHue(rgb.r, rgb.g, rgb.b);
  return hslToHex(hue, PASTEL_SATURATION, PASTEL_LIGHTNESS);
}

export function hueFromCustomColor(value: string): number {
  const rgb = parseHexColor(value);
  return rgb ? rgbToHue(rgb.r, rgb.g, rgb.b) : DEFAULT_HUE;
}

export function customPillColorFromHue(hue: number): string {
  return hslToHex(hue, PASTEL_SATURATION, PASTEL_LIGHTNESS);
}

function parseHexColor(value: string) {
  const normalized = value.trim();
  const fullHex = normalized.match(/^#?([0-9a-f]{6})$/i)?.[1];
  if (!fullHex) return null;
  return {
    r: Number.parseInt(fullHex.slice(0, 2), 16),
    g: Number.parseInt(fullHex.slice(2, 4), 16),
    b: Number.parseInt(fullHex.slice(4, 6), 16),
  };
}

function rgbToHue(r: number, g: number, b: number): number {
  const r1 = r / 255;
  const g1 = g / 255;
  const b1 = b / 255;
  const max = Math.max(r1, g1, b1);
  const min = Math.min(r1, g1, b1);
  const delta = max - min;
  if (delta === 0) return DEFAULT_HUE;
  let hue: number;
  if (max === r1) {
    hue = ((g1 - b1) / delta) % 6;
  } else if (max === g1) {
    hue = (b1 - r1) / delta + 2;
  } else {
    hue = (r1 - g1) / delta + 4;
  }
  return Math.round((hue * 60 + 360) % 360);
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const h = (((hue % 360) + 360) % 360) / 360;
  const s = saturation / 100;
  const l = lightness / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = hueToRgb(p, q, h + 1 / 3);
  const g = hueToRgb(p, q, h);
  const b = hueToRgb(p, q, h - 1 / 3);
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hueToRgb(p: number, q: number, t: number): number {
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
