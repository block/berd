import { describe, expect, it, vi } from "vitest";
import { isWithinBase } from "../artifactAutoOpenPolicy";
import {
  getRelativeWorkspacePath,
  isSameWorkspacePath,
  normalizeComparableWorkspacePath,
  workspaceAttachmentIdForPath,
} from "../workspaceAttachments";
import { resolveImageContentSrc } from "../../ui/resolveImageContentSrc";
import { shortenTerminalPath } from "../../../terminal/model/terminalState";
import { shortenPath as shortenWorkspacePath } from "../../ui/widgets/workspacePath";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, scheme?: string) =>
    `${scheme ?? "asset"}:${path}`,
}));

describe("Windows and Unix path identity contract", () => {
  it.each([
    ["drive path", "C:\\Repo\\Source\\", "c:/repo/source"],
    ["drive root", "C:\\", "c:/"],
    [
      "UNC path",
      String.raw`\\Server\Share\Repo\Source\\`,
      "//server/share/repo/source",
    ],
    ["Unix path", "/Users/Alice/Repo/", "/Users/Alice/Repo"],
    ["Unix root", "/", "/"],
    ["home-relative Unix path", "~/Repo/", "~/Repo"],
    ["Unix parent traversal", "/../../tmp", "/tmp"],
  ])("normalizes a %s comparison key", (_label, path, expected) => {
    expect(normalizeComparableWorkspacePath(path)).toBe(expected);
  });

  it.each([
    [
      "drive case and separators",
      String.raw`C:\Repo\Source`,
      "c:/repo/source/",
      true,
    ],
    ["drive roots", "C:\\", "c:/", true],
    [
      "UNC case and separators",
      String.raw`\\Server\Share\Repo`,
      "//server/share/repo/",
      true,
    ],
    [
      "different UNC shares",
      String.raw`\\server\share-a\repo`,
      String.raw`\\server\share-b\repo`,
      false,
    ],
    ["drive prefix collision", "C:/repo", "c:/repository", false],
    ["different drives", "C:/repo", "D:/repo", false],
    ["exact Unix identity", "/Users/Alice/Repo/", "/Users/Alice/Repo", true],
    [
      "case-distinct Unix identity",
      "/Users/Alice/Repo",
      "/users/alice/repo",
      false,
    ],
  ])("compares %s", (_label, left, right, expected) => {
    expect(isSameWorkspacePath(left, right)).toBe(expected);
  });

  it.each([
    ["Windows drive variants", "C:\\Repo\\", "c:/repo", "path:c:/repo"],
    [
      "UNC variants",
      String.raw`\\Server\Share\Repo`,
      "//server/share/repo/",
      "path://server/share/repo",
    ],
    [
      "case-distinct Unix paths",
      "/Users/Alice/Repo",
      "/users/alice/repo",
      null,
    ],
  ])("uses platform-aware identity for %s attachment IDs", (_label, left, right, sharedId) => {
    if (sharedId) {
      expect(workspaceAttachmentIdForPath(left)).toBe(sharedId);
      expect(workspaceAttachmentIdForPath(right)).toBe(sharedId);
    } else {
      expect(workspaceAttachmentIdForPath(left)).not.toBe(
        workspaceAttachmentIdForPath(right),
      );
    }
  });

  it.each([
    [
      "mixed drive spelling",
      "c:/repo/Source/Index.ts",
      String.raw`C:\Repo`,
      "Source/Index.ts",
    ],
    [
      "UNC spelling",
      String.raw`\\server\share\repo\Docs\Read Me.md`,
      "//SERVER/share/REPO",
      "Docs/Read Me.md",
    ],
    [
      "UNC parent traversal",
      "//server/share/repo/../../outside.md",
      "//SERVER/share",
      "outside.md",
    ],
    ["drive root", "c:/repo/file.md", "C:\\", "repo/file.md"],
    ["drive-root parent traversal", "C:/../outside.md", "c:/", "outside.md"],
    ["Unix root", "/tmp/repo/file.md", "/", "tmp/repo/file.md"],
    ["Unix descendant", "/Users/Alice/Repo/docs", "/Users/Alice/Repo", "docs"],
    ["drive prefix collision", "C:/repository/file.md", "c:/repo", null],
    [
      "UNC prefix collision",
      "//server/share/repository/file.md",
      "//server/share/repo",
      null,
    ],
    [
      "case-distinct Unix path",
      "/Users/Alice/repo/file.md",
      "/Users/Alice/Repo",
      null,
    ],
  ])("finds a relative path for %s", (_label, path, root, expected) => {
    expect(getRelativeWorkspacePath(path, root)).toBe(expected);
  });

  it("keeps parent traversal when joining relative paths", () => {
    expect(
      getRelativeWorkspacePath("C:/repo/../outside.md", "c:/repo"),
    ).toBeNull();
    expect(
      getRelativeWorkspacePath(
        "//server/share/repo/../outside.md",
        "//server/share/repo",
      ),
    ).toBeNull();
  });

  it.each([
    ["Windows drive", "C:/Repo", "c:/repo/file.md", true],
    [
      "mixed Windows drive separators",
      String.raw`C:\Repo`,
      "c:/REPO/file.md",
      true,
    ],
    [
      "UNC",
      String.raw`\\Server\Share\Repo`,
      "//server/share/repo/file.md",
      true,
    ],
    ["drive root", "C:\\", "c:/repo/file.md", true],
    ["Unix root", "/", "/tmp/file.md", true],
    ["Unix descendant", "/Users/Alice/Repo", "/Users/Alice/Repo/file.md", true],
    [
      "Unix case mismatch",
      "/Users/Alice/Repo",
      "/users/alice/repo/file.md",
      false,
    ],
    ["sibling prefix", "/work/repo", "/work/repository/file.md", false],
  ])("checks containment for %s", (_label, root, path, expected) => {
    expect(isWithinBase(root, path)).toBe(expected);
  });
});

describe("file URL conversion contract", () => {
  it.each([
    [
      "Windows drive URL",
      "file:///C:/Users/Alice/My%20Files/report%23final-%E9%9B%AA.png",
      "asset:C:/Users/Alice/My Files/report#final-雪.png",
    ],
    [
      "lowercase drive URL",
      "file:///c:/repo/image%2520.png",
      "asset:c:/repo/image%20.png",
    ],
    [
      "UNC authority",
      "file://Server/Share/My%20Files/report%23final.png",
      "asset://server/Share/My Files/report#final.png",
    ],
    [
      "Unix URL",
      "file:///tmp/My%20Files/report%23final-%E9%9B%AA.png",
      "asset:/tmp/My Files/report#final-雪.png",
    ],
    [
      "localhost Unix URL",
      "file://localhost/tmp/report.png",
      "asset:/tmp/report.png",
    ],
    [
      "single-slash Unix URL",
      "file:/tmp/My%20Files/report.png",
      "asset:/tmp/My Files/report.png",
    ],
    [
      "single-slash Windows drive URL",
      "file:C:/Users/Alice/report.png",
      "asset:C:/Users/Alice/report.png",
    ],
  ])("converts a %s with URL semantics", (_label, uri, expected) => {
    expect(resolveImageContentSrc({ data: "", uri })).toBe(expected);
  });

  it.each([
    ["malformed escape", "file:///tmp/report%ZZ.png"],
    ["malformed Unicode escape", "file:///tmp/%E0%A4%A.png"],
    ["encoded slash", "file:///tmp/report%2Fsecret.png"],
    ["encoded backslash", "file:///tmp/report%5Csecret.png"],
    ["encoded NUL", "file:///tmp/report%00.png"],
    ["credentials", "file://user@server/share/report.png"],
  ])("rejects an unsafe %s", (_label, uri) => {
    expect(resolveImageContentSrc({ data: "", uri })).toBeNull();
  });

  it.each([
    ["query", "file:///tmp/report.png?download=1"],
    ["fragment", "file:///tmp/report.png#preview"],
  ])("rejects a file URL with a %s", (_label, uri) => {
    expect(resolveImageContentSrc({ data: "", uri })).toBeNull();
  });

  it("does not reinterpret a remote URL as a filesystem path", () => {
    expect(
      resolveImageContentSrc({
        data: "",
        uri: "https://example.com/report%20final.png",
      }),
    ).toBe("https://example.com/report%20final.png");
  });
});

describe("path display regressions", () => {
  it.each([
    ["Unix root", "/", "/"],
    ["short Unix path", "/tmp/repo", "/tmp/repo"],
    ["long Unix path", "/Users/Alice/Repo", "~/Alice/Repo"],
    ["Windows drive root", "C:\\", "C:/"],
    [
      "long Windows drive path",
      String.raw`C:\Users\Alice\Repo`,
      "~/Alice/Repo",
    ],
    [
      "long UNC path",
      String.raw`\\server\share\projects\Repo`,
      "~/projects/Repo",
    ],
    ["Unicode path", String.raw`C:\Users\Alice\雪\資料`, "~/雪/資料"],
  ])("shortens a terminal %s", (_label, path, expected) => {
    expect(shortenTerminalPath(path)).toBe(expected);
  });

  it.each([
    [
      "Unix path",
      "/Users/Alice/Repo-worktrees/feature",
      "~/Repo-worktrees/feature",
    ],
    [
      "Windows drive path",
      String.raw`C:\Users\Alice\Repo-worktrees\feature`,
      "…/Repo-worktrees/feature",
    ],
    [
      "UNC path",
      String.raw`\\server\share\Repo-worktrees\feature`,
      "…/Repo-worktrees/feature",
    ],
  ])("shortens a workspace %s", (_label, path, expected) => {
    expect(shortenWorkspacePath(path)).toBe(expected);
  });
});
