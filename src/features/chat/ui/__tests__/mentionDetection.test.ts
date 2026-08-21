import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  type FileMentionItem,
  type SkillMentionItem,
  useMentionDetection,
} from "../mentionDetection";

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

function skillItem(overrides: Partial<SkillMentionItem>): SkillMentionItem {
  return {
    id: "global:/skills/example",
    name: "example",
    description: "Example skill",
    sourceLabel: "Personal",
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
  it("keeps a dismissed mention closed while typing in the same token", () => {
    const { result } = renderHook(() => useMentionDetection([], [], []));

    act(() => {
      result.current.detectMention("@log", 4);
    });
    expect(result.current.mentionOpen).toBe(true);

    act(() => {
      result.current.dismissMention();
      result.current.detectMention("@logfold", 8);
    });
    expect(result.current.mentionOpen).toBe(false);

    act(() => {
      result.current.detectMention("@logfold @new", 13);
    });
    expect(result.current.mentionOpen).toBe(true);
    expect(result.current.mentionQuery).toBe("new");
  });

  it("opens a replacement token at the same position after dismissal", () => {
    const { result } = renderHook(() => useMentionDetection([], [], []));

    act(() => {
      result.current.detectMention("@old", 4);
      result.current.dismissMention();
      result.current.detectMention("@new", 4);
    });

    expect(result.current.mentionOpen).toBe(true);
    expect(result.current.mentionQuery).toBe("new");
  });

  it("closing a selected mention does not suppress a later token", () => {
    const { result } = renderHook(() => useMentionDetection([], [], []));

    act(() => {
      result.current.detectMention("@first", 6);
      result.current.closeMention();
      result.current.detectMention("@new", 4);
    });

    expect(result.current.mentionOpen).toBe(true);
    expect(result.current.mentionQuery).toBe("new");
  });

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

  it("ranks skill name matches before earlier description matches", () => {
    const descriptionMatch = skillItem({
      id: "global:/skills/release-notes",
      name: "release-notes",
      description: "write code status summaries",
    });
    const nameMatch = skillItem({
      id: "global:/skills/code-review",
      name: "code-review",
      description: "reviews diffs",
    });
    const { result } = renderHook(() =>
      useMentionDetection([], [descriptionMatch, nameMatch], []),
    );

    act(() => {
      result.current.detectMention("/code", 5);
    });

    expect(result.current.filteredSkills).toEqual([
      nameMatch,
      descriptionMatch,
    ]);
  });

  it("ranks skill name prefix matches before earlier substring matches", () => {
    const substringMatch = skillItem({
      id: "global:/skills/pr-comments-for-copied-code",
      name: "pr-comments-for-copied-code",
    });
    const prefixMatch = skillItem({
      id: "global:/skills/code-review",
      name: "code-review",
    });
    const { result } = renderHook(() =>
      useMentionDetection([], [substringMatch, prefixMatch], []),
    );

    act(() => {
      result.current.detectMention("/code", 5);
    });

    expect(result.current.filteredSkills).toEqual([
      prefixMatch,
      substringMatch,
    ]);
  });

  it.each([
    "first",
    "last",
  ] as const)("ranks a case-insensitive exact skill name match first when it appears %s", (exactPosition) => {
    const exactMatch = skillItem({
      id: "global:/skills/code",
      name: "CODE",
    });
    const prefixMatches = [
      skillItem({
        id: "global:/skills/code-review",
        name: "code-review",
      }),
      skillItem({
        id: "global:/skills/codesearch",
        name: "codesearch",
      }),
    ];
    const skills =
      exactPosition === "first"
        ? [exactMatch, ...prefixMatches]
        : [...prefixMatches, exactMatch];
    const { result } = renderHook(() => useMentionDetection([], skills, []));

    act(() => {
      result.current.detectMention("/code", 5);
    });

    expect(result.current.filteredSkills).toEqual([
      exactMatch,
      ...prefixMatches,
    ]);
  });

  it("keeps description-only skill matches when no title matches", () => {
    const descriptionMatch = skillItem({
      id: "global:/skills/release-notes",
      name: "release-notes",
      description: "write code status summaries",
    });
    const nonMatch = skillItem({
      id: "global:/skills/triage",
      name: "triage",
      description: "sort feedback",
    });
    const { result } = renderHook(() =>
      useMentionDetection([], [descriptionMatch, nonMatch], []),
    );

    act(() => {
      result.current.detectMention("/code", 5);
    });

    expect(result.current.filteredSkills).toEqual([descriptionMatch]);
  });

  it("preserves skill order for an empty slash query at prompt start", () => {
    const firstSkill = skillItem({
      id: "global:/skills/release-notes",
      name: "release-notes",
    });
    const secondSkill = skillItem({
      id: "global:/skills/code-review",
      name: "code-review",
    });
    const { result } = renderHook(() =>
      useMentionDetection([], [firstSkill, secondSkill], []),
    );

    act(() => {
      result.current.detectMention("/", 1);
    });

    expect(result.current.filteredSkills).toEqual([firstSkill, secondSkill]);
  });

  it("opens slash skills at token boundaries once there is a query", () => {
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

  it("does not open slash skills inside another token or for empty later slashes", () => {
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

    act(() => {
      result.current.detectMention("using it /", 10);
    });
    expect(result.current.mentionOpen).toBe(false);
  });

  it("does not keep slash skills open for path-shaped slash queries", () => {
    const skill = {
      id: "global:/skills/code-review",
      name: "code-review",
      description: "Reviews code",
      sourceLabel: "Personal",
    };
    const { result } = renderHook(() => useMentionDetection([], [skill], []));

    act(() => {
      result.current.detectMention("/Users/me", 9);
    });
    expect(result.current.mentionOpen).toBe(false);

    act(() => {
      result.current.detectMention("open /Users/me", 14);
    });
    expect(result.current.mentionOpen).toBe(false);

    act(() => {
      result.current.detectMention("/tmp\\project", 12);
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
      resolvedPath: "/project/berd/src/main.ts",
      displayPath: "berd/src/main.ts",
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
      resolvedPath: "/project/berd/src/main.ts",
      displayPath: "berd/src/main.ts",
      filename: "main.ts",
      source: "project",
    });
    const { result } = renderHook(() => useMentionDetection([], [], [file]));

    act(() => {
      result.current.detectMention("@berd/src", 9);
    });
    act(() => {
      result.current.setAtMentionCategory("files");
    });

    expect(result.current.mentionOpen).toBe(true);
    expect(result.current.mentionTrigger).toBe("@");
    expect(result.current.mentionQuery).toBe("berd/src");
    expect(result.current.atMentionCategory).toBe("files");
  });

  it("matches the project root shortcut when the root folder query has a trailing slash", () => {
    const projectRoot = fileItem({
      resolvedPath: "/Users/morganm/Development/berd",
      displayPath: "Project root",
      filename: "berd",
      kind: "folder",
      source: "project",
      shortcut: "projectRoot",
    });
    const { result } = renderHook(() =>
      useMentionDetection([], [], [projectRoot]),
    );

    openFilesMention(result, "@berd/");

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
        "/Users/kalvin/Development/squareup/berd/scripts/generate-release-notes.sh",
      displayPath:
        "/Users/kalvin/Development/squareup/berd/scripts/generate-release-notes.sh",
      filename: "generate-release-notes.sh",
      source: "session",
    });
    const unrelatedContext = fileItem({
      resolvedPath:
        "/Users/kalvin/Development/squareup/berd/src/features/home/lib/homePinLabelPreference.ts",
      displayPath:
        "/Users/kalvin/Development/squareup/berd/src/features/home/lib/homePinLabelPreference.ts",
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
