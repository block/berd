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

  it("matches against any alias when a skill has more than one historical pin id", () => {
    // A skill can accumulate more than one legacy alias (a pre-#974
    // Personal-skill migration, plus a rename retiring an old-named copy
    // from a second legacy location). A pin on either alias must resolve --
    // not just whichever happened to be recorded last.
    const aliases = [
      "global:/Users/test/.agents/skills/goose-help",
      "global:/Users/test/.berd/skills/goose-help",
    ];

    expect(
      areSkillPinIdsEquivalent(
        "global:/Users/test/.agents/skills/goose-help",
        "app:/Users/test/Library/Application Support/xyz.block.berd/skills/berd-help",
        aliases,
      ),
    ).toBe(true);

    expect(
      areSkillPinIdsEquivalent(
        "global:/Users/test/.berd/skills/goose-help",
        "app:/Users/test/Library/Application Support/xyz.block.berd/skills/berd-help",
        aliases,
      ),
    ).toBe(true);
  });

  it("does not match an alias that isn't in the historical pin id list", () => {
    expect(
      areSkillPinIdsEquivalent(
        "global:/Users/test/.agents/skills/unrelated-skill",
        "app:/Users/test/Library/Application Support/xyz.block.berd/skills/berd-help",
        [
          "global:/Users/test/.agents/skills/goose-help",
          "global:/Users/test/.berd/skills/goose-help",
        ],
      ),
    ).toBe(false);
  });
});
