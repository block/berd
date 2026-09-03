import { describe, expect, it } from "vitest";
import {
  buildNoticerSystemPrompt,
  NOTICER_VOCABULARY,
  parseNoticerOutput,
} from "../memoryNoticer";

describe("buildNoticerSystemPrompt", () => {
  it("carries the bounded vocabulary and the caps", () => {
    const prompt = buildNoticerSystemPrompt([]);
    for (const name of NOTICER_VOCABULARY) {
      expect(prompt).toContain(name);
    }
    expect(prompt).toContain("Never invent a narrower topic name");
    expect(prompt).toContain("untrusted input");
  });

  it("prefers the user's existing topics when they have some", () => {
    const prompt = buildNoticerSystemPrompt(["Woodworking", "Family"]);
    expect(prompt).toContain("Woodworking, Family");
    expect(prompt).toContain("always prefer routing to one of these");
  });
});

describe("parseNoticerOutput", () => {
  it("parses candidates and keeps vocabulary topics", () => {
    const out = parseNoticerOutput(
      '[{"content": "Youngest has soccer Monday and Thursday evenings.", "topic": "Home"}]',
      [],
    );
    expect(out).toEqual([
      {
        content: "Youngest has soccer Monday and Thursday evenings.",
        topic: "Home",
      },
    ]);
  });

  it("accepts the user's existing topics as routes", () => {
    const out = parseNoticerOutput(
      '[{"content": "Uses walnut for most builds.", "topic": "Woodworking"}]',
      ["Woodworking"],
    );
    expect(out).toHaveLength(1);
    expect(out[0].topic).toBe("Woodworking");
  });

  it("drops candidates with out-of-vocabulary topic names", () => {
    const out = parseNoticerOutput(
      '[{"content": "Kid plays striker.", "topic": "Soccer"}]',
      [],
    );
    expect(out).toEqual([]);
  });

  it("routes null topics to the spine", () => {
    const out = parseNoticerOutput(
      '[{"content": "Always ask before deleting anything.", "topic": null}]',
      [],
    );
    expect(out[0].topic).toBeNull();
  });

  it("tolerates code fences and surrounding prose", () => {
    const out = parseNoticerOutput(
      'Here you go:\n```json\n[{"content": "Vegetarian.", "topic": "Home"}]\n```',
      [],
    );
    expect(out).toHaveLength(1);
  });

  it("treats NONE, junk, and empty as no candidates", () => {
    expect(parseNoticerOutput("NONE", [])).toEqual([]);
    expect(parseNoticerOutput("none of note", [])).toEqual([]);
    expect(parseNoticerOutput("not json at all", [])).toEqual([]);
    expect(parseNoticerOutput(null, [])).toEqual([]);
    expect(parseNoticerOutput('{"content": "not an array"}', [])).toEqual([]);
  });

  it("caps the number of candidates per pass", () => {
    const many = JSON.stringify(
      Array.from({ length: 8 }, (_, i) => ({
        content: `Fact number ${i}.`,
        topic: "Home",
      })),
    );
    expect(parseNoticerOutput(many, []).length).toBeLessThanOrEqual(3);
  });

  it("drops oversized and empty content", () => {
    const out = parseNoticerOutput(
      `[{"content": "", "topic": "Home"}, {"content": "${"x".repeat(400)}", "topic": "Home"}]`,
      [],
    );
    expect(out).toEqual([]);
  });
});
