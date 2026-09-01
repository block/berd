import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const globalsCss = readFileSync(
  resolve(process.cwd(), "src/shared/styles/globals.css"),
  "utf8",
);

describe("Streamdown table styles", () => {
  it("allows header cells to wrap without changing body-cell wrapping", () => {
    expect(globalsCss).toMatch(
      /\[data-streamdown="table"\]\s+th\s*\{[^}]*font-size:\s*0\.6875rem;[^}]*font-weight:\s*600;[^}]*line-height:\s*1rem;[^}]*white-space:\s*normal;/s,
    );
    expect(globalsCss).not.toMatch(
      /\[data-streamdown="table"\]\s+th\s*\{[^}]*(?:letter-spacing|text-transform):/s,
    );
    expect(globalsCss).toMatch(
      /\[data-streamdown="table"\]\s+td\s*\{[^}]*font-size:\s*0\.8125rem;[^}]*overflow-wrap:\s*anywhere;/s,
    );
    expect(globalsCss).not.toMatch(
      /\[data-streamdown="table"\]\s+td\s*\{[^}]*white-space:\s*normal;/s,
    );
  });

  it("allows vertical scrolling for tables taller than the max height", () => {
    expect(globalsCss).toMatch(
      /table-wrapper"\][^}]*> div:has\(> \[data-streamdown="table"\]\)\s*\{[^}]*overflow-y:\s*auto;/s,
    );
    expect(globalsCss).not.toMatch(
      /table-wrapper"\][^}]*overflow-y:\s*hidden/s,
    );
  });
});
