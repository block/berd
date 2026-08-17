import { describe, expect, it } from "vitest";

import { filterMemoryPaths } from "../meAgentEdits";

const HOME = "/home/u";

describe("filterMemoryPaths", () => {
  it("keeps the spine and topic docs, and nothing else", () => {
    const paths = [
      "/home/u/.me/family.md",
      "/home/u/.me/me.md",
      "/home/u/projects/notes.md",
      "/home/u/.me/.proposals/pending.jsonl",
      "/home/u/.me/nested/dir.md",
      "/home/u/.me/style.md",
    ];
    expect(filterMemoryPaths(paths, HOME)).toEqual([
      "/home/u/.me/family.md",
      "/home/u/.me/me.md",
      "/home/u/.me/style.md",
    ]);
  });

  it("attributes edits to namespaced topic docs", () => {
    const paths = [
      "/home/u/.me/topics/family.md",
      "/home/u/.me/topics/deeper/nope.md",
      "/home/u/.me/.git/COMMIT_EDITMSG",
    ];
    expect(filterMemoryPaths(paths, HOME)).toEqual([
      "/home/u/.me/topics/family.md",
    ]);
  });

  it("dedupes repeated locations from multi-edit tool calls", () => {
    const paths = ["/home/u/.me/family.md", "/home/u/.me/family.md"];
    expect(filterMemoryPaths(paths, HOME)).toEqual(["/home/u/.me/family.md"]);
  });

  it("returns empty for non-memory paths", () => {
    expect(
      filterMemoryPaths(["/home/u/code/app.ts", "/tmp/scratch.md"], HOME),
    ).toEqual([]);
  });
});
