import { describe, expect, it } from "vitest";
import {
  deriveAgentCardTraitLines,
  deriveAgentShareCardTextLayout,
} from "./agentShareCardLayout";

const measure = (text: string) => Array.from(text).length * 10;

describe("deriveAgentShareCardTextLayout", () => {
  it("keeps a two-line description in the default content position", () => {
    const layout = deriveAgentShareCardTextLayout(
      "Reviewer",
      "one two three four",
      measure,
      measure,
    );
    expect(layout.descriptionLines).toEqual(["one two three four"]);
    expect(layout.contentShift).toBe(0);
  });

  it("shifts title and description together when three lines are required", () => {
    const layout = deriveAgentShareCardTextLayout(
      "Reviewer",
      "one two three four five six",
      measure,
      (text) => Array.from(text).length * 100,
    );
    expect(layout.descriptionLines).toHaveLength(3);
    expect(layout.contentShift).toBe(52);
  });

  it("bounds long localized trait copy to the shared two-line region", () => {
    expect(
      deriveAgentCardTraitLines(
        "Ideal para:",
        "convertir objetivos en planes prácticos y alcanzables",
        170,
        measure,
        "es",
      ),
    ).toEqual(["Ideal para:", "convertir…"]);
  });

  it("clamps long words and Unicode without splitting graphemes", () => {
    const layout = deriveAgentShareCardTextLayout(
      "😀😀😀😀😀😀",
      "averylongunbrokenwordthatcontinueswellpastthreelines",
      (text) => Array.from(text).length * 300,
      (text) => Array.from(text).length * 100,
    );
    expect(layout.title).toMatch(/…$/u);
    expect(layout.title).not.toContain("�");
    const graphemeLayout = deriveAgentShareCardTextLayout(
      "👨‍👩‍👧‍👦👨‍👩‍👧‍👦",
      "你好世界这是一个没有空格的说明文本",
      (text) => Array.from(text).length * 300,
      (text) => Array.from(text).length * 100,
      "zh",
    );
    expect(graphemeLayout.title).not.toContain("�");
    expect(graphemeLayout.descriptionLines.length).toBeGreaterThan(1);
    expect(layout.descriptionLines).toHaveLength(3);
    expect(layout.descriptionLines[2]).toMatch(/…$/u);
  });
});
