import guidance from "../../../../distro/skills/berd-help/references/berdctl.md?raw";
import { describe, expect, it } from "vitest";

describe("berdctl session creation guidance", () => {
  it("describes ordinary standalone background sessions, not parent-linked sessions", () => {
    expect(guidance).toContain("standalone background session");
    expect(guidance).toContain("does not record a parent relationship");
    expect(guidance).not.toMatch(
      /\bchild(?:['’]s)?\b|\bsub[-_ ]session\b|\bsub[-_ ]agent\b/i,
    );
  });
});
