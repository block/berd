import { describe, expect, it } from "vitest";
import { areSkillPinIdsEquivalent } from "./skillPinIdentity";

describe("areSkillPinIdsEquivalent", () => {
  it("matches a legacy bundled Personal id to its Berd app id", () => {
    expect(
      areSkillPinIdsEquivalent(
        "global:/Users/test/.agents/skills/agent-builder",
        "app:/Users/test/Library/Application Support/xyz.block.berd/skills/agent-builder",
        "global:/Users/test/.agents/skills/agent-builder",
      ),
    ).toBe(true);
  });

  it("does not alias a same-named Personal skill without a migration record", () => {
    expect(
      areSkillPinIdsEquivalent(
        "global:/Users/test/.agents/skills/agent-builder",
        "app:/Users/test/Library/Application Support/xyz.block.berd/skills/agent-builder",
      ),
    ).toBe(false);
  });

  it("normalizes SKILL.md suffixes and path separators", () => {
    expect(
      areSkillPinIdsEquivalent(
        "app:C:\\Users\\test\\Berd\\skills\\goose-help\\SKILL.md",
        "app:C:/Users/test/Berd/skills/goose-help",
        null,
      ),
    ).toBe(true);
  });
});
