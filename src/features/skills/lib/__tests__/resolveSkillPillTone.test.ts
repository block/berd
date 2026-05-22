import { describe, it, expect } from "vitest";
import {
  resolveSkillPillTone,
  skillPillToneClass,
  SKILL_PILL_TONES,
} from "@/features/skills/lib/resolveSkillPillTone";

describe("resolveSkillPillTone", () => {
  it("is deterministic — same name always returns the same tone", () => {
    const name = "code-review";
    const a = resolveSkillPillTone(name);
    const b = resolveSkillPillTone(name);
    const c = resolveSkillPillTone(name);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("always returns one of the registered tones", () => {
    const tone = resolveSkillPillTone("anything");
    expect(SKILL_PILL_TONES).toContain(tone);
  });

  it("spreads across multiple tones for a representative sample", () => {
    const names = [
      "layout",
      "code-review",
      "test-writer",
      "goose-doc-guide",
      "polish",
      "audit",
      "summarize",
      "translate",
      "refactor",
      "explain",
      "lint",
      "format",
      "search",
      "deploy",
      "monitor",
      "debug",
      "design",
      "spec",
      "plan",
      "ship",
    ];

    const seen = new Set(names.map((name) => resolveSkillPillTone(name)));
    // At least 3 distinct tones across the sample.
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it("handles an empty string without throwing", () => {
    expect(() => resolveSkillPillTone("")).not.toThrow();
    const tone = resolveSkillPillTone("");
    expect(SKILL_PILL_TONES).toContain(tone);
  });
});

describe("skillPillToneClass", () => {
  it("returns a bg-pill-* class for every registered tone", () => {
    for (const tone of SKILL_PILL_TONES) {
      const cls = skillPillToneClass(tone);
      expect(cls).toBe(`bg-pill-${tone}`);
    }
  });
});
