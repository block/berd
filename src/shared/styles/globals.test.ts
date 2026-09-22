import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const globalsCss = readFileSync(
  resolve(process.cwd(), "src/shared/styles/globals.css"),
  "utf8",
);

function declarationsFor(selector: string): string {
  const selectorStart = globalsCss.indexOf(selector);
  if (selectorStart === -1) {
    throw new Error(`Missing ${selector} theme block`);
  }

  const blockStart = globalsCss.indexOf("{", selectorStart);
  const blockEnd = globalsCss.indexOf("\n}", blockStart);
  if (blockStart === -1 || blockEnd === -1) {
    throw new Error(`Malformed ${selector} theme block`);
  }

  return globalsCss.slice(blockStart + 1, blockEnd);
}

describe("text shimmer motion", () => {
  it("keeps the default cadence while loading states opt into a continuous sweep", () => {
    const defaultKeyframes = declarationsFor("@keyframes text-shimmer {");
    const continuousKeyframes = declarationsFor(
      "@keyframes text-shimmer-continuous {",
    );

    expect(defaultKeyframes).toContain("70%,");
    expect(continuousKeyframes).not.toContain("70%,");
    expect(continuousKeyframes).toContain("100%");
  });
});

describe("card-glass surface", () => {
  it("derives the glass panel fill from the card token in both themes", () => {
    const lightTheme = declarationsFor(":root {");
    const darkTheme = declarationsFor('[data-theme="dark"],');

    expect(lightTheme).toContain(
      "--card-glass: color-mix(in srgb, var(--card) 78%, transparent);",
    );
    expect(darkTheme).toContain(
      "--card-glass: color-mix(in srgb, var(--card) 82%, transparent);",
    );
  });
});

describe("background token", () => {
  it("aliases card in both themes so paper-intent controls track the card surface", () => {
    // `bg-background` consumers (outline buttons, file chips, kbd, line
    // masks) all mean "paper". Light mode always had background == card ==
    // white; dark mode drifting to black is how controls turned into black
    // blobs on gray-800 cards.
    const lightTheme = declarationsFor(":root {");
    const darkTheme = declarationsFor('[data-theme="dark"],');

    expect(lightTheme).toContain("--background: var(--card);");
    expect(darkTheme).toContain("--background: var(--card);");
  });

  it("keeps intentionally black dark chrome pinned to the palette, not the alias", () => {
    const darkTheme = declarationsFor('[data-theme="dark"],');

    expect(darkTheme).toContain(
      "--surface-chat-responding-pill-bg: var(--color-black);",
    );
    expect(darkTheme).toContain(
      "--surface-agent-tile-action-bg: var(--color-black);",
    );
    // The hover state inverts onto a white fill, so its label stays black
    // rather than following the background→card alias.
    expect(darkTheme).toContain(
      "--surface-agent-tile-action-fg-hover: var(--color-black);",
    );
  });

  it("keeps the onboarding tour scrim pinned to literals, not the alias", () => {
    // The tour overlay used bg-background/40 when background meant
    // white/black; as a modal scrim it must keep tinting white in light
    // and dimming in dark instead of following the paper alias to card.
    const lightTheme = declarationsFor(":root {");
    const darkTheme = declarationsFor('[data-theme="dark"],');

    expect(lightTheme).toContain(
      "--overlay-onboarding-scrim: rgba(255, 255, 255, 0.4);",
    );
    expect(darkTheme).toContain(
      "--overlay-onboarding-scrim: rgba(0, 0, 0, 0.4);",
    );
  });
});

type TokenDeclarations = Map<string, string>;

function declarationsMap(selector: string): TokenDeclarations {
  const map: TokenDeclarations = new Map();
  for (const match of declarationsFor(selector).matchAll(
    /^\s*(--[\w-]+):\s*([^;]+);/gm,
  )) {
    map.set(match[1], match[2].trim());
  }
  return map;
}

/** Resolve a custom property to a literal color, following var() chains. */
function resolveToken(
  token: string,
  theme: TokenDeclarations,
  palette: TokenDeclarations,
): string {
  let value: string = theme.get(token) ?? palette.get(token) ?? "";
  if (value === "") {
    throw new Error(`Missing ${token}`);
  }
  const seen = new Set<string>();
  for (;;) {
    const ref = value.match(/^var\((--[\w-]+)(?:,\s*([^)]+))?\)$/);
    if (!ref) {
      return value;
    }
    if (seen.has(ref[1])) {
      throw new Error(`Circular var() reference at ${ref[1]}`);
    }
    seen.add(ref[1]);
    const next: string =
      theme.get(ref[1]) ?? palette.get(ref[1]) ?? ref[2]?.trim() ?? "";
    if (next === "") {
      throw new Error(`Unresolved var() reference ${ref[1]} in ${token}`);
    }
    value = next;
  }
}

function srgbChannelToLinear(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of a #rrggbb color. */
function relativeLuminance(hex: string): number {
  const digits = hex.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(digits)) {
    throw new Error(`Unsupported color for contrast math: ${hex}`);
  }
  const [red, green, blue] = [0, 2, 4].map((offset) =>
    srgbChannelToLinear(parseInt(digits.slice(offset, offset + 2), 16) / 255),
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [
    relativeLuminance(foreground),
    relativeLuminance(background),
  ].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("muted-foreground on popover", () => {
  it("clears 3:1 non-text contrast in both themes for icon-only controls (model picker star)", () => {
    const palette = declarationsMap("@theme {");
    for (const selector of [":root {", '[data-theme="dark"],']) {
      const theme = declarationsMap(selector);
      const foreground = resolveToken("--muted-foreground", theme, palette);
      const background = resolveToken("--popover", theme, palette);
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(3);
    }
  });
});
