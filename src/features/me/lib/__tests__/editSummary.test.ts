import { describe, expect, it } from "vitest";

import { removedMemoryEntries } from "../editSummary";

const FILE = `# Me

*This file is yours.*

## Preferences

*How you want agents to work with you.*

- Keep answers brief.
- Git branch names: use \`clay/\` as the prefix.

## Boundaries

*Things agents should ask about first.*
`;

describe("removedMemoryEntries", () => {
  it("returns exact removed entries without markdown syntax", () => {
    const after = FILE.replace("- Keep answers brief.\n", "");
    expect(removedMemoryEntries(FILE, after)).toEqual(["Keep answers brief."]);
  });

  it("does not suppress entries during additions or rewording", () => {
    expect(
      removedMemoryEntries(
        FILE,
        FILE.replace(
          "- Keep answers brief.",
          "- Keep answers brief.\n- Use headings for long answers.",
        ),
      ),
    ).toEqual([]);
    expect(
      removedMemoryEntries(
        FILE,
        FILE.replace("- Keep answers brief.", "- Keep responses brief."),
      ),
    ).toEqual([]);
  });

  it("ignores whitespace, headings, and italic notes", () => {
    expect(removedMemoryEntries(FILE, `${FILE}\n\n`)).toEqual([]);
    expect(
      removedMemoryEntries(
        FILE,
        FILE.replace("*This file is yours.*", "*Yours.*"),
      ),
    ).toEqual([]);
    expect(
      removedMemoryEntries(FILE, FILE.replace("## Boundaries", "## Limits")),
    ).toEqual([]);
  });
});
