import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const desktopAgentCss = readFileSync(
  resolve(process.cwd(), "src/features/desktop-agent/ui/desktop-agent.css"),
  "utf8",
);

function blockFor(selector: string): string {
  const selectorStart = desktopAgentCss.indexOf(selector);
  if (selectorStart === -1) {
    throw new Error(`Missing ${selector} block`);
  }

  const blockStart = desktopAgentCss.indexOf("{", selectorStart);
  const blockEnd = desktopAgentCss.indexOf("\n}", blockStart);
  if (blockStart === -1 || blockEnd === -1) {
    throw new Error(`Malformed ${selector} block`);
  }

  return desktopAgentCss.slice(blockStart, blockEnd + 2);
}

describe("desktop-agent CSS tokens", () => {
  it("keeps raw color literals scoped to the panel token block", () => {
    const tokenBlock = blockFor("#root {");
    const cssOutsideTokenBlock = desktopAgentCss.replace(tokenBlock, "");

    expect(tokenBlock).toMatch(/--desktop-agent-surface:/);
    expect(tokenBlock).toMatch(/--desktop-agent-foreground:/);
    expect(tokenBlock).toMatch(/--desktop-agent-primary-action:/);
    expect(cssOutsideTokenBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba\(/);
  });
});
