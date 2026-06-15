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

function openFilesMention(
  result: { current: ReturnType<typeof useMentionDetection> },
  text: string,
) {
  act(() => {
    result.current.detectMention(text, text.length);
  });
  act(() => {
    result.current.navigateAtMentionCategory("next");
  });
}

describe("useMentionDetection file ordering", () => {
  it("defaults @ mentions to agents and shows skills only for slash commands", () => {
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
    expect(result.current.mentionTrigger).toBe("@");
    expect(result.current.atMentionCategory).toBe("agents");
    expect(result.current.filteredSkills).toEqual([]);

    act(() => {
      result.current.detectMention("/code", 5);
    });
    expect(result.current.mentionOpen).toBe(true);
    expect(result.current.mentionTrigger).toBe("/");
    expect(result.current.atMentionCategory).toBe("skills");
    expect(result.current.filteredSkills).toEqual([skill]);
  });

  it("opens slash skills at token boundaries in the composer", () => {
    const skill = {
      id: "global:/skills/code-review",
      name: "code-review",
      description: "Reviews code",
      sourceLabel: "Personal",
    };
    const { result } = renderHook(() => useMentionDetection([], [skill], []));

    act(() => {
      result.current.detectMention("please use /code", 16);
    });
    expect(result.current.mentionOpen).toBe(true);
    expect(result.current.mentionTrigger).toBe("/");
    expect(result.current.mentionStartIndex).toBe(11);
    expect(result.current.atMentionCategory).toBe("skills");
    expect(result.current.filteredSkills).toEqual([skill]);

    act(() => {
      result.current.detectMention("please use\n/code", 16);
    });
    expect(result.current.mentionOpen).toBe(true);
    expect(result.current.mentionStartIndex).toBe(11);
    expect(result.current.filteredSkills).toEqual([skill]);
  });

  it("does not open slash skills inside another token", () => {
    const skill = {
      id: "global:/skills/code-review",
      name: "code-review",
      description: "Reviews code",
      sourceLabel: "Personal",
    };
    const { result } = renderHook(() => useMentionDetection([], [skill], []));

    act(() => {
      result.current.detectMention("src/features", 12);
    });

    expect(result.current.mentionOpen).toBe(false);
  });

  it("cycles @ categories between agents and files", () => {
    const { result } = renderHook(() => useMentionDetection([], [], []));

    act(() => {
      result.current.detectMention("@rea", 4);
    });
    expect(result.current.atMentionCategory).toBe("agents");

    act(() => {
      result.current.navigateAtMentionCategory("next");
    });
    expect(result.current.atMentionCategory).toBe("files");

    act(() => {
      result.current.navigateAtMentionCategory("previous");
    });
    expect(result.current.atMentionCategory).toBe("agents");
  });

  it("keeps the active skills tab while typing an @ mention query", () => {
    const skill = {
      id: "global:/skills/code-review",
      name: "code-review",
      description: "Reviews code",
      sourceLabel: "Personal",
    };
    const { result } = renderHook(() => useMentionDetection([], [skill], []));

    act(() => {
      result.current.detectMention("@", 1);
    });
    act(() => {
      result.current.setAtMentionCategory("skills");
    });
    act(() => {
      result.current.detectMention("@code", 5);
    });

    expect(result.current.atMentionCategory).toBe("skills");
    expect(result.current.filteredSkills).toEqual([skill]);
  });

  it("opens fresh @ mentions on the configured default category", () => {
    const file = fileItem({
      resolvedPath: "/project/goose-internal/src/main.ts",
      displayPath: "goose-internal/src/main.ts",
      filename: "main.ts",
      source: "project",
    });
    const { result } = renderHook(() =>
      useMentionDetection([], [], [file], "files"),
    );

    act(() => {
      result.current.detectMention("@main", 5);
    });

    expect(result.current.mentionOpen).toBe(true);
    expect(result.current.mentionTrigger).toBe("@");
    expect(result.current.atMentionCategory).toBe("files");
    expect(result.current.filteredFiles).toHaveLength(1);
    expect(result.current.filteredFiles[0]?.resolvedPath).toBe(
      file.resolvedPath,
    );
  });

  it("keeps slashes inside @ file paths in the file mention query", () => {
    const file = fileItem({
      resolvedPath: "/project/goose-internal/src/main.ts",
      displayPath: "goose-internal/src/main.ts",
      filename: "main.ts",
      source: "project",
    });
    const { result } = renderHook(() => useMentionDetection([], [], [file]));

    act(() => {
      result.current.detectMention("@goose-internal/src", 19);
    });
    act(() => {
      result.current.setAtMentionCategory("files");
    });

    expect(result.current.mentionOpen).toBe(true);
    expect(result.current.mentionTrigger).toBe("@");
    expect(result.current.mentionQuery).toBe("goose-internal/src");
    expect(result.current.atMentionCategory).toBe("files");
  });

  it("matches the project root shortcut when the root folder query has a trailing slash", () => {
    const projectRoot = fileItem({
      resolvedPath: "/Users/morganm/Development/goose-internal",
      displayPath: "Project root",
      filename: "goose-internal",
      kind: "folder",
      source: "project",
      shortcut: "projectRoot",
    });
    const { result } = renderHook(() =>
      useMentionDetection([], [], [projectRoot]),
    );

    openFilesMention(result, "@goose-internal/");

    expect(result.current.filteredFiles).toEqual([projectRoot]);
  });

  it("keeps a clicked tab while typing a slash mention query", () => {
    const persona = {
      id: "reviewer",
      displayName: "Reviewer",
      systemPrompt: "",
      isBuiltin: true,
      writable: false,
      createdAt: "",
      updatedAt: "",
    };
    const { result } = renderHook(() => useMentionDetection([persona], [], []));

    act(() => {
      result.current.detectMention("/", 1);
    });
    expect(result.current.atMentionCategory).toBe("skills");

    act(() => {
      result.current.setAtMentionCategory("agents");
    });
    act(() => {
      result.current.detectMention("/rev", 4);
    });

    expect(result.current.atMentionCategory).toBe("agents");
    expect(result.current.filteredPersonas).toEqual([persona]);
  });

  it("does not fuzzy-match local entries only by their path", () => {
    // A session-context item whose long absolute path happens to contain the
    // query as a scattered subsequence ("r..d..m..e"). Local fuzzy matching is
    // filename-only so this does not compete with backend-ranked file results.
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
    openFilesMention(result, "@rdme");

    const filenames = result.current.filteredFiles.map((f) => f.filename);
    expect(filenames).toEqual(["readme.md"]);
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
    openFilesMention(result, "@grn");

    expect(result.current.filteredFiles.map((f) => f.filename)).toEqual([
      "generate-release-notes.sh",
      "groupSessionsByDate.ts",
    ]);
  });

  it("does not fuzzy-match dotted path queries across unrelated path fields", () => {
    const releaseNotes = fileItem({
      resolvedPath:
        "/Users/kalvin/Development/squareup/goose-internal/scripts/generate-release-notes.sh",
      displayPath:
        "/Users/kalvin/Development/squareup/goose-internal/scripts/generate-release-notes.sh",
      filename: "generate-release-notes.sh",
      source: "session",
    });
    const unrelatedContext = fileItem({
      resolvedPath:
        "/Users/kalvin/Development/squareup/goose-internal/src/features/home/lib/homePinLabelPreference.ts",
      displayPath:
        "/Users/kalvin/Development/squareup/goose-internal/src/features/home/lib/homePinLabelPreference.ts",
      filename: "homePinLabelPreference.ts",
      source: "session",
    });

    const { result } = renderHook(() =>
      useMentionDetection([], [], [releaseNotes, unrelatedContext]),
    );
    openFilesMention(result, "@notes.sh");

    expect(result.current.filteredFiles.map((f) => f.filename)).toEqual([
      "generate-release-notes.sh",
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
    openFilesMention(result, "@gen");

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
    openFilesMention(result, `@${path} dfjadf`);
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
    openFilesMention(result, withNewMention);
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
    openFilesMention(result, "@chatin");

    const filenames = result.current.filteredFiles.map((f) => f.filename);
    expect(filenames).toEqual(["chatinput.ts", "chart-input.ts"]);
  });
});
