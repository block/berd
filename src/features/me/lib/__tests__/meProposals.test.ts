import { describe, expect, it } from "vitest";

import { appendBullet, insertIntoSection, removeBullet } from "../meProposals";
import { vocabularyTopicName } from "../memoryTopicVocabulary";

describe("appendBullet", () => {
  it("appends a bullet to existing content with one trailing newline", () => {
    const next = appendBullet("# Family\n\n- Existing entry.\n", "New entry.");
    expect(next).toBe("# Family\n\n- Existing entry.\n- New entry.\n");
  });

  it("starts a doc when contents are empty", () => {
    expect(appendBullet("", "First entry.")).toBe("- First entry.\n");
  });
});

describe("insertIntoSection", () => {
  const SPINE = [
    "# Me",
    "",
    "## About me",
    "",
    "- Clay, Atlanta.",
    "",
    "## Preferences",
    "",
    "- Keep answers brief.",
    "",
    "## Boundaries",
    "",
    "- Ask before deleting.",
    "",
  ].join("\n");

  it("inserts at the end of the named section, before the next heading", () => {
    const next = insertIntoSection(SPINE, "## Preferences", "Use metric.");
    const lines = next.split("\n");
    const prefIndex = lines.indexOf("- Keep answers brief.");
    expect(lines[prefIndex + 1]).toBe("- Use metric.");
    // Boundaries untouched and still after the insertion.
    expect(next.indexOf("- Use metric.")).toBeLessThan(
      next.indexOf("## Boundaries"),
    );
  });

  it("falls back to appending when the section is missing", () => {
    const next = insertIntoSection("# Me\n", "## Nonexistent", "Entry.");
    expect(next.trimEnd().endsWith("- Entry.")).toBe(true);
  });
});

describe("vocabularyTopicName", () => {
  it("accepts the broad areas, case-insensitively", () => {
    expect(vocabularyTopicName("home")).toBe("Home");
    expect(vocabularyTopicName("  Travel ")).toBe("Travel");
    expect(vocabularyTopicName("Interests")).toBe("Interests");
  });

  it("rejects narrow names a drifting model might invent", () => {
    // Approval falls back to the spine for these rather than minting a
    // topic file the noticer would never produce.
    expect(vocabularyTopicName("Soccer")).toBeNull();
    expect(vocabularyTopicName("Jazz")).toBeNull();
    expect(vocabularyTopicName("family")).toBeNull();
  });
});

describe("removeBullet", () => {
  const DOC = [
    "# Home",
    "",
    "*What goes here.*",
    "",
    "- Kids' soccer is Mondays.",
    "- Wife works late Tuesdays.",
    "",
  ].join("\n");

  it("removes the matching bullet and leaves the rest", () => {
    const next = removeBullet(DOC, "Wife works late Tuesdays.");
    expect(next).not.toContain("Wife works late Tuesdays.");
    expect(next).toContain("- Kids' soccer is Mondays.");
    expect(next).toContain("*What goes here.*");
  });

  it("no-ops when the entry was reworded or already gone", () => {
    // Deleting a nearby line the user wrote themselves would be far worse
    // than a delete that does nothing, so matching is exact.
    expect(removeBullet(DOC, "Wife works late on Tuesdays")).toBe(DOC);
    expect(removeBullet(DOC, "Never mentioned.")).toBe(DOC);
  });

  it("removes only the first match", () => {
    const doubled = "- Same fact.\n- Same fact.\n";
    expect(removeBullet(doubled, "Same fact.")).toBe("- Same fact.\n");
  });
});
