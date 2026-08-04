import { describe, expect, it } from "vitest";
import {
  changedFilesQueryKey,
  gitStateQueryKey,
  normalizeGitPath,
} from "./gitStateQueryKey";

const HOME = "/Users/test";

describe("normalizeGitPath", () => {
  it("expands a leading ~ once the home dir is known", () => {
    expect(normalizeGitPath("~/project", HOME)).toBe("/Users/test/project");
    expect(normalizeGitPath("~", HOME)).toBe("/Users/test");
  });

  it("passes absolute paths through untouched", () => {
    expect(normalizeGitPath("/Users/test/project", HOME)).toBe(
      "/Users/test/project",
    );
  });

  it("falls back to the raw spelling before the home dir resolves", () => {
    expect(normalizeGitPath("~/project", null)).toBe("~/project");
  });

  it("preserves nullish paths", () => {
    expect(normalizeGitPath(null, HOME)).toBeNull();
    expect(normalizeGitPath(undefined, HOME)).toBeUndefined();
  });
});

describe("git query key builders", () => {
  it("build matching keys for the ~ and absolute spellings of one directory", () => {
    expect(gitStateQueryKey("~/project", HOME)).toEqual(
      gitStateQueryKey("/Users/test/project", HOME),
    );
    expect(changedFilesQueryKey("~/project", HOME)).toEqual(
      changedFilesQueryKey("/Users/test/project", HOME),
    );
  });

  it("namespace their keys distinctly", () => {
    expect(gitStateQueryKey("/Users/test/project", HOME)).toEqual([
      "git-state",
      "/Users/test/project",
    ]);
    expect(changedFilesQueryKey("/Users/test/project", HOME)).toEqual([
      "changed-files",
      "/Users/test/project",
    ]);
  });
});
