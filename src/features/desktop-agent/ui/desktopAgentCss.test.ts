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

function declarationMatches(block: string): string[] {
  return Array.from(
    block.matchAll(/(^|\n)\s*[^\n{}:;]+:\s*[^;]+;/g),
    ([match]) => match,
  );
}

function declarationsFor(block: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const declaration of declarationMatches(block)) {
    const [property, value] = declaration.split(/:(.*)/s);
    declarations.set(property.trim(), value.replace(/;$/, "").trim());
  }
  return declarations;
}

function tokenValues(): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const declaration of declarationMatches(blockFor("#root {"))) {
    const [token, value] = declaration.split(/:(.*)/s);
    tokens.set(token.trim(), value.replace(/;$/, "").trim());
  }
  return tokens;
}

function canonicalCssValue(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")")
    .trim();
}

function resolveToken(value: string, tokens: Map<string, string>): string {
  const tokenName = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  if (!tokenName) return value;
  const resolved = tokens.get(tokenName);
  if (resolved === undefined) throw new Error(`Missing token ${tokenName}`);
  return resolveToken(resolved, tokens);
}

describe("desktop-agent CSS tokens", () => {
  it("keeps raw color literals scoped to the panel token block", () => {
    const tokenBlock = blockFor("#root {");
    const cssOutsideTokenBlock = desktopAgentCss.replace(tokenBlock, "");

    expect(cssOutsideTokenBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba\(/);
  });

  it("keeps refactored tokens pixel-identical for pinned rules", () => {
    const tokens = tokenValues();
    const pinned: Record<string, Record<string, string>> = {
      ".markdown-body blockquote": {
        "border-left": "3px solid rgba(255, 255, 255, 0.25)",
        color: "rgba(228, 228, 231, 0.8)",
      },
      ".icon-button": {
        background: "rgba(255, 255, 255, 0.08)",
        color: "rgba(255, 255, 255, 0.7)",
      },
      ".tool-result": {
        background: "rgba(255, 255, 255, 0.055)",
        color: "rgba(255, 255, 255, 0.72)",
      },
      ".composer-only .composer-box": {
        "border-color": "rgba(255, 255, 255, 0.08)",
      },
    };

    for (const [selector, expected] of Object.entries(pinned)) {
      const declarations = declarationsFor(blockFor(selector));
      for (const [property, value] of Object.entries(expected)) {
        const actual = declarations.get(property);
        if (actual === undefined) {
          throw new Error(`Missing ${property} in ${selector}`);
        }
        expect(
          canonicalCssValue(
            actual.replace(/var\((--[\w-]+)\)/g, (_, token: string) =>
              resolveToken(`var(${token})`, tokens),
            ),
          ),
        ).toBe(value);
      }
    }
  });
});
