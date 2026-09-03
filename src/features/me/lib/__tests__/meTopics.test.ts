import { describe, expect, it } from "vitest";
import { parseTopicMeta, topicFileName } from "../meTopics";

describe("parseTopicMeta", () => {
  it("uses the first heading as the label and the first italic note as the description", () => {
    const meta = parseTopicMeta(
      [
        "# Style",
        "",
        "*Brands, fits, and preferences your style agent uses.*",
        "",
        "## Brands",
        "",
        "- Prefer Uniqlo basics.",
      ].join("\n"),
      "style.md",
    );

    expect(meta.label).toBe("Style");
    expect(meta.description).toBe(
      "Brands, fits, and preferences your style agent uses.",
    );
  });

  it("collapses multi-line italic notes into one line", () => {
    const meta = parseTopicMeta(
      "# Travel\n\n*Where you like to go\nand how you like to get there.*",
      "travel.md",
    );

    expect(meta.description).toBe(
      "Where you like to go and how you like to get there.",
    );
  });

  it("falls back to the file name when there is no heading", () => {
    const meta = parseTopicMeta("- just some bullets", "side-projects.md");

    expect(meta.label).toBe("Side-projects");
    expect(meta.description).toBeNull();
  });

  it("does not mistake bold text or bullets for the description", () => {
    const meta = parseTopicMeta(
      "# Work\n\n**Not a note.**\n\n* also not a note\n\n- entry",
      "work.md",
    );

    expect(meta.description).toBeNull();
  });
});

describe("topicFileName", () => {
  it("slugs display names into file names", () => {
    expect(topicFileName("Style")).toBe("style.md");
    expect(topicFileName("Side projects")).toBe("side-projects.md");
    expect(topicFileName("  Kids' activities!  ")).toBe("kids-activities.md");
  });

  it("never produces an empty slug", () => {
    expect(topicFileName("!!!")).toBe("topic.md");
  });
});
