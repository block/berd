import { describe, expect, it } from "vitest";
import { deriveAgentShareCardTextLayout } from "./agentShareCardLayout";

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

  it("clamps long words and Unicode without splitting surrogate pairs", () => {
    const layout = deriveAgentShareCardTextLayout(
      "😀😀😀😀😀😀",
      "averylongunbrokenword",
      (text) => Array.from(text).length * 300,
      (text) => Array.from(text).length * 100,
    );
    expect(layout.title).toMatch(/…$/u);
    expect(layout.title).not.toContain("�");
    expect(layout.descriptionLines[0]).toMatch(/…$/u);
  });
});
