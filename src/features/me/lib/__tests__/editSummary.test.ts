import { describe, expect, it } from "vitest";

import { summarizeEdit } from "../editSummary";

const FILE = `# Me

*This file is yours.*

## Preferences

*How you want agents to work with you.*

- Keep answers brief.
- Git branch names: use \`clay/\` as the prefix.

## Boundaries

*Things agents should ask about first.*
`;

describe("summarizeEdit", () => {
  it("names the entry when one line is removed", () => {
    // The case that prompted this: a removed line stays recoverable in the
    // trail, so the history has to say which one it was.
    const after = FILE.replace(
      "- Git branch names: use `clay/` as the prefix.\n",
      "",
    );
    expect(summarizeEdit(FILE, after)).toBe(
      "Remove: Git branch names: use `clay/` as the prefix.",
    );
  });

  it("names the entry when one line is added", () => {
    const after = FILE.replace(
      "- Keep answers brief.",
      "- Keep answers brief.\n- Vegetarian.",
    );
    expect(summarizeEdit(FILE, after)).toBe("Add: Vegetarian.");
  });

  it("reports a reworded line as a change", () => {
    const after = FILE.replace(
      "- Keep answers brief.",
      "- Keep answers very brief.",
    );
    expect(summarizeEdit(FILE, after)).toBe("Change: Keep answers very brief.");
  });

  it("counts larger edits instead of quoting them", () => {
    const after = FILE.replace(
      "- Keep answers brief.\n- Git branch names: use `clay/` as the prefix.",
      "- One.\n- Two.\n- Three.",
    );
    expect(summarizeEdit(FILE, after)).toBe("Edit: added 3, removed 2");
  });

  it("truncates a long entry to one line", () => {
    const long = `- ${"x".repeat(120)}`;
    const after = FILE.replace("- Keep answers brief.", long);
    const summary = summarizeEdit(FILE, after) ?? "";
    expect(summary.startsWith("Change: ")).toBe(true);
    expect(summary.length).toBeLessThan(70);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("ignores whitespace, headings, and the italic notes", () => {
    // Rewording a hint changes nothing an agent reads, so it shouldn't read
    // as an edit to what Berd knows.
    expect(summarizeEdit(FILE, `${FILE}\n\n`)).toBeNull();
    expect(
      summarizeEdit(FILE, FILE.replace("*This file is yours.*", "*Yours.*")),
    ).toBeNull();
    expect(
      summarizeEdit(FILE, FILE.replace("## Boundaries", "## Limits")),
    ).toBeNull();
  });
});
