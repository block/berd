import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  validateBundledAgent,
  validateBundledAgentFile,
} from "../../../scripts/validate-bundled-agents";

const VALID_AGENT = `---
name: Support bot
description: Answers support questions.
avatar: app-avatar:gloopies-19
metadata:
  berdBundled: true
---

Agent instructions.
`;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("validateBundledAgent", () => {
  it("accepts a valid bundled agent", () => {
    expect(validateBundledAgent("support-bot.md", VALID_AGENT)).toEqual([]);
  });

  it("requires markdown files", () => {
    expect(validateBundledAgent("support-bot.txt", VALID_AGENT)).toEqual([
      "support-bot.txt: bundled agent file must have a .md extension",
    ]);
  });

  it("requires frontmatter", () => {
    expect(
      validateBundledAgent("support-bot.md", "Agent instructions."),
    ).toEqual([
      "support-bot.md: agent must start with a YAML frontmatter block delimited by `---`",
    ]);
  });

  it.each([
    "---garbage",
    "----",
    "--- # comment",
  ])("rejects an invalid closing delimiter: %s", (delimiter) => {
    expect(
      validateBundledAgent(
        "support-bot.md",
        VALID_AGENT.replace(
          "---\n\nAgent instructions.",
          `${delimiter}\nAgent instructions.`,
        ),
      ),
    ).toEqual([
      "support-bot.md: agent must start with a YAML frontmatter block delimited by `---`",
    ]);
  });

  it("requires bundled-agent metadata", () => {
    const errors = validateBundledAgent(
      "support-bot.md",
      VALID_AGENT.replace("  berdBundled: true", "  berdBundled: false"),
    );

    expect(errors).toContain(
      "support-bot.md: frontmatter must set `metadata.berdBundled: true` so the agent is treated as bundled",
    );
  });

  it("requires an app avatar ref", () => {
    const errors = validateBundledAgent(
      "support-bot.md",
      VALID_AGENT.replace(
        "app-avatar:gloopies-19",
        "https://example.com/avatar.png",
      ),
    );

    expect(errors).toContain(
      "support-bot.md: frontmatter `avatar` is required and must be an `app-avatar:<id>` ref",
    );
  });

  it.each([
    "app-avatar:",
    "app-avatar:../secret",
    "app-avatar:INVALID",
  ])("rejects an invalid app avatar ref: %s", (avatar) => {
    const errors = validateBundledAgent(
      "support-bot.md",
      VALID_AGENT.replace(
        "avatar: app-avatar:gloopies-19",
        `avatar: "${avatar}"`,
      ),
    );

    expect(errors).toContain(
      "support-bot.md: frontmatter `avatar` is required and must be an `app-avatar:<id>` ref",
    );
  });

  it("rejects invalid UTF-8 files", () => {
    const dir = mkdtempSync(join(tmpdir(), "bundled-agent-"));
    tempDirs.push(dir);
    const filePath = join(dir, "support-bot.md");
    writeFileSync(
      filePath,
      Buffer.concat([Buffer.from(VALID_AGENT), Buffer.from([0xff])]),
    );

    expect(validateBundledAgentFile(filePath)).toEqual([
      expect.stringContaining("failed to read file"),
    ]);
  });

  it("requires name and description", () => {
    const errors = validateBundledAgent(
      "support-bot.md",
      `---
name: ""
description: ""
avatar: app-avatar:gloopies-19
metadata:
  berdBundled: true
---
`,
    );

    expect(errors).toEqual([
      "support-bot.md: frontmatter `name` is required and must be a string",
      "support-bot.md: frontmatter `description` is required and must be a string",
    ]);
  });
});
