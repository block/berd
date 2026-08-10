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

describe("chat context panel surface", () => {
  it("uses light-on-dark danger colors in both app themes", () => {
    const panelSurface = declarationsFor(".chat-context-panel-surface {");

    expect(panelSurface).toContain("--destructive: var(--color-red-400);");
    expect(panelSurface).toContain("--status-deleted: var(--color-red-100);");
  });
});

describe("dark navigation surface", () => {
  it("keeps the shared surface dark while navigation uses its paired token", () => {
    const lightTheme = declarationsFor(":root {");
    const darkTheme = declarationsFor('[data-theme="dark"],');

    expect(lightTheme).toContain(
      "--sidebar-navigation-panel-bg: rgba(255, 255, 255, 0.8);",
    );
    expect(darkTheme).toContain("--sidebar: rgba(0, 0, 0, 0.62);");
    expect(darkTheme).toContain(
      "--sidebar-navigation-panel-bg: rgba(0, 0, 0, 0.5);",
    );
  });
});
