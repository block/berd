import { describe, expect, it } from "vitest";

import {
  fileUrlToPath,
  getPathBasename,
  getRelativePath,
  isFileUrl,
  isPathWithin,
  isSamePath,
  isWindowsPath,
  toComparablePath,
  toIdentityKey,
} from "./pathIdentity";

describe("toComparablePath", () => {
  it.each([
    ["C:\\Users\\dev", "C:/Users/dev"],
    ["c:/Users/dev/", "c:/Users/dev"],
    ["/Users/dev/", "/Users/dev"],
    ["/Users/dev///", "/Users/dev"],
    ["\\\\server\\share\\dir", "//server/share/dir"],
    ["C:\\", "C:/"],
    ["/", "/"],
    ["C:/repo/../src", "C:/src"],
    [" folder /file ", " folder /file "],
    ["//server/share/repo/../../outside", "//server/share/outside"],
    ["/../../tmp", "/tmp"],
    ["relative/dir", "relative/dir"],
    ["C:foo/../bar", "C:bar"],
    ["D:foo/../bar", "D:bar"],
    ["C:../bar", "C:../bar"],
    ["C:../../bar", "C:../../bar"],
    ["C:foo/../../bar", "C:../bar"],
  ])("normalizes %s -> %s (case preserved)", (input, expected) => {
    expect(toComparablePath(input)).toBe(expected);
  });
});

describe("isWindowsPath", () => {
  it.each([
    ["C:\\Users", true],
    ["c:/users", true],
    ["C:", false],
    ["\\\\server\\share", true],
    ["//server/share", true],
    ["/Users/dev", false],
    ["relative/path", false],
    ["", false],
  ])("classifies %s as windows=%s", (input, expected) => {
    expect(isWindowsPath(input)).toBe(expected);
  });
});

describe("toIdentityKey", () => {
  it("folds case for drive-letter paths", () => {
    expect(toIdentityKey("C:\\Users\\Dev")).toBe(toIdentityKey("c:/users/dev"));
  });

  it("folds case for UNC paths", () => {
    expect(toIdentityKey("\\\\Server\\Share\\Dir")).toBe(
      toIdentityKey("//server/share/dir"),
    );
  });

  it("keeps drive-relative paths distinct by drive and from ordinary relative paths", () => {
    expect(toIdentityKey("C:foo/../bar")).toBe("C:bar");
    expect(toIdentityKey("D:foo/../bar")).toBe("D:bar");
    expect(toIdentityKey("C:foo/../bar")).not.toBe(toIdentityKey("bar"));
    expect(toIdentityKey("C:foo/../bar")).not.toBe(
      toIdentityKey("D:foo/../bar"),
    );
    expect(toIdentityKey("C:foo")).not.toBe(toIdentityKey("c:foo"));
    expect(toIdentityKey("C:../bar")).not.toBe(toIdentityKey("C:../../bar"));
  });

  it("keeps Unix paths case-sensitive on the non-browser Linux default", () => {
    expect(toIdentityKey("/Users/Dev")).not.toBe(toIdentityKey("/users/dev"));
    expect(toIdentityKey("/Users/Dev")).toBe("/Users/Dev");
  });
});

describe("isSamePath", () => {
  it.each([
    ["C:\\Users\\dev", "c:/users/DEV", true],
    ["C:\\Users\\dev\\", "C:/Users/dev", true],
    ["\\\\Server\\Share", "//server/share", true],
    ["/Users/dev", "/users/dev", false],
    ["/Users/dev", "/Users/dev/", true],
    ["/Users/dev", "/Users/other", false],
  ])("%s vs %s -> %s", (a, b, expected) => {
    expect(isSamePath(a, b)).toBe(expected);
  });

  it("applies platform case semantics to Unix-style paths", () => {
    expect(toIdentityKey("/Users/Dev/Repo", "mac")).toBe("/users/dev/repo");
    expect(toIdentityKey("/Users/Dev/Repo", "linux")).toBe("/Users/Dev/Repo");
    expect(isSamePath("/Users/Dev/Repo", "/users/dev/repo", "mac")).toBe(true);
    expect(isSamePath("/Users/Dev/Repo", "/users/dev/repo", "linux")).toBe(
      false,
    );
  });

  it("returns false for nullish inputs", () => {
    expect(isSamePath(null, "/a")).toBe(false);
    expect(isSamePath("/a", undefined)).toBe(false);
  });
});

describe("isPathWithin", () => {
  it.each([
    // Base, target, expected
    ["C:\\work", "c:/work/sub/file.txt", true],
    ["C:\\work", "C:/work", true],
    ["C:\\work", "C:/work-secrets/file.txt", false], // prefix collision
    ["/work", "/work-secrets/file.txt", false], // prefix collision
    ["/Users/dev", "/users/dev/file", false], // unix case-sensitive
    ["\\\\srv\\share", "//srv/share/deep/file", true],
    ["/work", "/work/a/b", true],
    ["C:\\", "c:/work/a.ts", true],
    ["/", "/work/a.ts", true],
    ["C:/work", "C:/work/../outside", false],
    ["//srv/share/work", "//srv/share/work/../outside", false],
    ["c:", "C:/foo", false],
    ["C:foo", "C:/foo", false],
    ["C:foo", "C:foo/bar", true],
    ["C:foo", "D:foo/bar", false],
  ])("within(%s, %s) -> %s", (base, target, expected) => {
    expect(isPathWithin(base, target)).toBe(expected);
  });

  it("uses platform case semantics for Unix-style containment", () => {
    expect(
      isPathWithin("/Users/Dev/Repo", "/users/dev/repo/file.md", "mac"),
    ).toBe(true);
    expect(
      isPathWithin("/Users/Dev/Repo", "/users/dev/repo/file.md", "linux"),
    ).toBe(false);
  });

  it("returns false for nullish inputs", () => {
    expect(isPathWithin(null, "/a")).toBe(false);
    expect(isPathWithin("/a", null)).toBe(false);
  });
});

describe("getRelativePath", () => {
  it.each([
    ["C:\\work\\src\\a.ts", "C:/work", "src/a.ts"],
    ["c:/WORK/src/a.ts", "C:\\work", "src/a.ts"], // case-insensitive base match
    ["C:\\work", "C:/work", ""],
    ["/Users/dev/repo/src/a.ts", "/Users/dev/repo", "src/a.ts"],
    ["/work-secrets/a.ts", "/work", null], // prefix collision
    ["\\\\srv\\share\\deep\\a.ts", "//srv/share", "deep/a.ts"],
    ["\\\\Server\\Share\\İ\\File.TS", "//server/share/İ", "File.TS"],
    ["C:/work/a.ts", "C:\\", "work/a.ts"],
    ["C:\\İ\\file.txt", "c:/İ", "file.txt"],
    ["/work/a.ts", "/", "work/a.ts"],
    ["/İ/file.txt", "/İ", "file.txt"],
    ["/İ/file.txt", "/i", null],
  ])("relative(%s, %s) -> %s", (path, root, expected) => {
    expect(getRelativePath(path, root)).toBe(expected);
  });

  it("uses platform case semantics for Unix-style relative paths", () => {
    expect(
      getRelativePath("/users/dev/repo/Src/File.ts", "/Users/Dev/Repo", "mac"),
    ).toBe("Src/File.ts");
    expect(
      getRelativePath(
        "/users/dev/repo/Src/File.ts",
        "/Users/Dev/Repo",
        "linux",
      ),
    ).toBeNull();
  });

  it("preserves the original spelling of the remainder", () => {
    // Base folds case, but the returned remainder keeps `path`'s spelling.
    expect(getRelativePath("C:\\Work\\Src\\File.TS", "c:/work")).toBe(
      "Src/File.TS",
    );
  });

  it("returns null for missing root", () => {
    expect(getRelativePath("/a/b", null)).toBe(null);
  });
});

describe("getPathBasename", () => {
  it.each([
    ["C:\\Users\\dev\\project", "project"],
    ["/Users/dev/project/", "project"],
    ["\\\\server\\share\\dir", "dir"],
    ["single", "single"],
    ["C:\\", "C:/"],
  ])("basename(%s) -> %s", (input, expected) => {
    expect(getPathBasename(input)).toBe(expected);
  });
});

describe("isFileUrl", () => {
  it.each([
    ["file:///tmp/a.png", true],
    [" file:/tmp/a.png ", true],
    ["FILE:C:/Users/dev/a.png", true],
    ["https://example.com/a.png", false],
    ["/tmp/a.png", false],
    ["", false],
  ])("classifies %s -> %s", (input, expected) => {
    expect(isFileUrl(input)).toBe(expected);
  });

  it("returns false for nullish input", () => {
    expect(isFileUrl(null)).toBe(false);
    expect(isFileUrl(undefined)).toBe(false);
  });
});

describe("fileUrlToPath", () => {
  it.each([
    ["file:///tmp/report.md", "/tmp/report.md"],
    ["file:///tmp/with%20space.png", "/tmp/with space.png"],
    ["file:///tmp/issue%23123.md", "/tmp/issue#123.md"],
    ["file:///tmp/caf%C3%A9.png", "/tmp/café.png"], // Unicode via percent
    ["file:///tmp/café.png", "/tmp/café.png"], // raw Unicode
    ["file:///C:/Users/dev/a.png", "C:/Users/dev/a.png"],
    ["file:///c:/x", "c:/x"],
    ["FILE:///tmp/a.png", "/tmp/a.png"], // scheme case-insensitive
    ["file://localhost/tmp/a.png", "/tmp/a.png"], // localhost authority dropped
    ["file://server/share/a.png", "//server/share/a.png"], // UNC authority preserved
    ["file:/tmp/a.png", "/tmp/a.png"],
    ["file:C:/Users/dev/a.png", "C:/Users/dev/a.png"],
  ])("decodes %s -> %s", (input, expected) => {
    expect(fileUrlToPath(input)).toBe(expected);
  });

  it.each([
    ["not a url"],
    ["/tmp/plain/path"],
    ["https://example.com/a.png"],
    ["file:report.md"], // relative path must not become /report.md
    ["file:./report.md"],
    ["file:../report.md"],
    ["file:%2E/report.md"],
    ["file:///tmp/bad%ZZ.png"], // malformed percent escape
    ["file:///tmp/%E0%A4%A.png"], // truncated multibyte escape
    ["file:///tmp/report%2Fsecret.png"], // encoded path separator
    ["file:///tmp/report%5Csecret.png"], // encoded Windows separator
    ["file:///tmp/report.png?download=1"],
    ["file:///tmp/report.png#preview"],
    ["file://user@server/share/report.png"],
    ["file:///tmp/a\u007fb.png"],
    [""],
  ])("rejects %s", (input) => {
    expect(fileUrlToPath(input)).toBeNull();
  });

  it("rejects embedded control characters", () => {
    expect(fileUrlToPath("file:///tmp/%00evil")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(fileUrlToPath(null)).toBeNull();
    expect(fileUrlToPath(undefined)).toBeNull();
  });
});
