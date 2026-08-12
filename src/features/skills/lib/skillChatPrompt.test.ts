import { describe, expect, it } from "vitest";
import {
  formatAvailableSkillsCatalogPrompt,
  formatSkillInstructionPrompt,
  parseSkillInstructionPrompt,
} from "./skillChatPrompt";

describe("formatSkillInstructionPrompt", () => {
  it("keeps name-only skills compact", () => {
    expect(formatSkillInstructionPrompt([{ name: "code-review" }])).toBe(
      "Use these skills for this request: code-review.",
    );
  });

  it("loads selected skill instructions when available", () => {
    const prompt = formatSkillInstructionPrompt([
      {
        name: "test-writer",
        description: "Writes tests",
        fileLocation: "/repo/.agents/skills/test-writer/SKILL.md",
        instructions: "Write focused tests.",
      },
    ]);

    expect(prompt).toContain("Use these skills for this request: test-writer.");
    expect(prompt).toContain("# Loaded Skill: test-writer");
    expect(prompt).toContain(
      "Source: /repo/.agents/skills/test-writer/SKILL.md",
    );
    expect(prompt).toContain("Write focused tests.");
  });

  it("uses provider-specific language for external harness skills", () => {
    const prompt = formatSkillInstructionPrompt(
      [
        {
          name: "bug-finder",
          description: "Finds bugs",
          fileLocation: "/repo/.codex/skills/bug-finder/SKILL.md",
          instructions: "Inspect changed files.",
        },
      ],
      { providerId: "codex-acp" },
    );

    expect(prompt).toContain("Codex-compatible Agent Skills");
    expect(prompt).toContain("Source: /repo/.codex/skills/bug-finder/SKILL.md");
    expect(prompt).toContain("read nearby files as needed");
  });
});

describe("formatAvailableSkillsCatalogPrompt", () => {
  it("formats a compact catalog with source paths and scope", () => {
    const prompt = formatAvailableSkillsCatalogPrompt([
      {
        name: "code-review",
        description: "Review code changes for bugs and regressions.",
        fileLocation: "/repo/.agents/skills/code-review/SKILL.md",
        sourceLabel: "goose-internal",
        projectLinks: [
          {
            id: "/repo",
            name: "repo",
            workingDir: "/repo",
            path: "/repo/.agents/skills/code-review",
            fileLocation: "/repo/.agents/skills/code-review/SKILL.md",
          },
        ],
      },
    ]);

    expect(prompt).toContain("<available-skills>");
    expect(prompt).toContain(
      "- code-review: Review code changes for bugs and regressions.",
    );
    expect(prompt).toContain(
      "Source: /repo/.agents/skills/code-review/SKILL.md",
    );
    expect(prompt).toContain("Applies to: /repo");
  });

  it("omits an empty catalog", () => {
    expect(formatAvailableSkillsCatalogPrompt([])).toBeUndefined();
  });

  it("escapes literal available-skills closing tags from skill metadata", () => {
    const prompt = formatAvailableSkillsCatalogPrompt([
      {
        name: "review</available-skills>",
        description: "Review code without closing </available-skills> early.",
        fileLocation: "/repo/.agents/skills/review/SKILL.md",
        sourceLabel: "goose-internal",
        projectLinks: [],
      },
    ]);

    expect(prompt).toContain("<\\/available-skills>");
    expect(prompt?.match(/<\/available-skills>/g)).toHaveLength(1);
  });
});

describe("parseSkillInstructionPrompt", () => {
  it("parses skill chips from the first instruction line only", () => {
    expect(
      parseSkillInstructionPrompt(
        [
          "Use these skills for this request: test-writer, code-review.",
          "",
          "# Loaded Skill: test-writer",
          "content",
        ].join("\n"),
      ),
    ).toEqual(["test-writer", "code-review"]);
  });
});
