import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type FileMentionItem, useMentionDetection } from "../mentionDetection";

function fileItem(overrides: Partial<FileMentionItem>): FileMentionItem {
  return {
    resolvedPath: "/project/file.ts",
    displayPath: "project/file.ts",
    filename: "file.ts",
    kind: "file",
    source: "project",
    ...overrides,
  };
}

describe("useMentionDetection file ordering", () => {
  it("shows skills only for slash commands, not @ mentions", () => {
    const skill = {
      id: "global:/skills/code-review",
      name: "code-review",
      description: "Reviews code",
      sourceLabel: "Personal",
    };
    const { result } = renderHook(() => useMentionDetection([], [skill], []));

    act(() => {
      result.current.detectMention("@code", 5);
    });
    expect(result.current.mentionOpen).toBe(true);
    expect(result.current.filteredSkills).toEqual([]);

    act(() => {
      result.current.detectMention("/code", 5);
    });
    expect(result.current.mentionOpen).toBe(true);
    expect(result.current.filteredSkills).toEqual([skill]);
  });

  it("ranks backend-matched entries above local fuzzy ties in the same tier", () => {
    // A session-context item whose long absolute path happens to contain the
    // query as a scattered subsequence ("r..d..m..e"), tying it into the
    // local fuzzy tier.
    const contextItem = fileItem({
      resolvedPath: "/users/kalvin/redmond/example.ts",
      displayPath: "/users/kalvin/redmond/example.ts",
      filename: "example.ts",
      source: "session",
    });
    // The backend's actual fuzzy filename match for the same query.
    const backendItem = fileItem({
      resolvedPath: "/project/readme.md",
      displayPath: "project/readme.md",
      filename: "readme.md",
      matchRank: 4,
      matchHighlight: { target: "filename", indices: [0, 3, 4, 5] },
    });

    const { result } = renderHook(() =>
      useMentionDetection([], [], [contextItem, backendItem]),
    );
    act(() => {
      result.current.detectMention("@rdme", 5);
    });

    const filenames = result.current.filteredFiles.map((f) => f.filename);
    expect(filenames).toEqual(["readme.md", "example.ts"]);
  });

  it("gives filename fuzzy matches on context files parity with backend fuzzy matches", () => {
    // Out-of-root context file: never in backend results, but its *name*
    // fuzzy-matches the query — that should compete with backend fuzzy
    // matches instead of sorting below all of them.
    const contextItem = fileItem({
      resolvedPath: "/worktrees/notes/scripts/generate-release-notes.sh",
      displayPath: "/worktrees/notes/scripts/generate-release-notes.sh",
      filename: "generate-release-notes.sh",
      source: "session",
    });
    const backendItem = fileItem({
      resolvedPath: "/project/src/groupSessionsByDate.ts",
      displayPath: "project/src/groupSessionsByDate.ts",
      filename: "groupSessionsByDate.ts",
      matchRank: 4,
    });

    const { result } = renderHook(() =>
      useMentionDetection([], [], [contextItem, backendItem]),
    );
    act(() => {
      result.current.detectMention("@grn", 4);
    });

    expect(result.current.filteredFiles.map((f) => f.filename)).toEqual([
      "generate-release-notes.sh",
      "groupSessionsByDate.ts",
    ]);
  });

  it("computes local highlights for entries the backend did not score", () => {
    // A session-context item outside the project roots: never in backend
    // results, so it has no matchHighlight of its own.
    const contextItem = fileItem({
      resolvedPath: "/elsewhere/generate-release-notes.sh",
      displayPath: "/elsewhere/generate-release-notes.sh",
      filename: "generate-release-notes.sh",
      source: "session",
    });
    const backendItem = fileItem({
      resolvedPath: "/project/generate-schema.ts",
      displayPath: "project/generate-schema.ts",
      filename: "generate-schema.ts",
      matchRank: 1,
      matchHighlight: { target: "filename", indices: [0, 1, 2] },
    });

    const { result } = renderHook(() =>
      useMentionDetection([], [], [contextItem, backendItem]),
    );
    act(() => {
      result.current.detectMention("@gen", 4);
    });

    const context = result.current.filteredFiles.find(
      (f) => f.filename === "generate-release-notes.sh",
    );
    expect(context?.matchHighlight).toEqual({
      target: "filename",
      indices: [0, 1, 2],
    });
    // Backend-provided highlights are preserved untouched.
    const backend = result.current.filteredFiles.find(
      (f) => f.filename === "generate-schema.ts",
    );
    expect(backend?.matchHighlight).toEqual({
      target: "filename",
      indices: [0, 1, 2],
    });
  });

  it("stops searching after a selected mention until a new @ is typed", () => {
    const { result } = renderHook(() => useMentionDetection([], [], []));
    const path = "/Users/me/projects/scripts/generate-release-notes.sh";

    // Without a completed selection, a path-like query with trailing text
    // keeps the mention open (paths may contain spaces).
    act(() => {
      result.current.detectMention(`@${path} dfjadf`, `@${path} dfjadf`.length);
    });
    expect(result.current.mentionOpen).toBe(true);

    act(() => {
      result.current.registerCompletedMention(path);
      result.current.detectMention(`@${path} dfjadf`, `@${path} dfjadf`.length);
    });
    expect(result.current.mentionOpen).toBe(false);

    // Cursor right after the inserted mention (trailing space) stays closed.
    act(() => {
      result.current.detectMention(`@${path} `, `@${path} `.length);
    });
    expect(result.current.mentionOpen).toBe(false);

    // A fresh @ after the completed mention searches again.
    const withNewMention = `@${path} see @rea`;
    act(() => {
      result.current.detectMention(withNewMention, withNewMention.length);
    });
    expect(result.current.mentionOpen).toBe(true);
    expect(result.current.mentionQuery).toBe("rea");
  });

  it("does not keep a stale text mention open when a later URL contains slashes", () => {
    const { result } = renderHook(() => useMentionDetection([], [], []));
    const text = "@code-review https://example.com/path";

    act(() => {
      result.current.detectMention(text, text.length);
    });

    expect(result.current.mentionOpen).toBe(false);
  });

  it("still allows spaces after a path-like mention token", () => {
    const { result } = renderHook(() => useMentionDetection([], [], []));
    const text = "@/Users/me/My Project/file.ts";

    act(() => {
      result.current.detectMention(text, text.length);
    });

    expect(result.current.mentionOpen).toBe(true);
    expect(result.current.mentionQuery).toBe("/Users/me/My Project/file.ts");
  });

  it("orders backend entries by their native rank", () => {
    const fuzzyMatchItem = fileItem({
      resolvedPath: "/project/chart-input.ts",
      displayPath: "project/chart-input.ts",
      filename: "chart-input.ts",
      matchRank: 4,
    });
    const prefixMatchItem = fileItem({
      resolvedPath: "/project/chatinput.ts",
      displayPath: "project/chatinput.ts",
      filename: "chatinput.ts",
      matchRank: 1,
    });

    const { result } = renderHook(() =>
      useMentionDetection([], [], [fuzzyMatchItem, prefixMatchItem]),
    );
    act(() => {
      result.current.detectMention("@chatin", 7);
    });

    const filenames = result.current.filteredFiles.map((f) => f.filename);
    expect(filenames).toEqual(["chatinput.ts", "chart-input.ts"]);
  });
});
