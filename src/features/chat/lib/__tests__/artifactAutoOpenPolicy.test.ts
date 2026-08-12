import { describe, expect, it } from "vitest";
import {
  isMachineryPath,
  isWithinBase,
  isWithinWorkRoots,
  isWriteLikeTool,
  shouldAutoOpenArtifact,
} from "../artifactAutoOpenPolicy";

const CWD = "/Users/dev/project";
/** Artifact root used by projectless "general" chats. */
const ARTIFACT_ROOT = "/Users/dev/goose artifacts";

function candidate(
  resolvedPath: string,
  overrides: { toolKind?: string | null; toolName?: string | null } = {},
) {
  // Use `in` rather than `??` so an explicit `null` (kind absent on the wire)
  // is preserved instead of falling back to the "edit" default.
  return {
    resolvedPath,
    toolKind: "toolKind" in overrides ? overrides.toolKind : "edit",
    toolName: "toolName" in overrides ? overrides.toolName : "write_file",
  };
}

describe("shouldAutoOpenArtifact", () => {
  it("opens an authored markdown document in the working tree", () => {
    expect(
      shouldAutoOpenArtifact(candidate(`${CWD}/blog-post.md`), {
        sessionCwd: CWD,
      }),
    ).toBe(true);
  });

  it("opens a nested document", () => {
    expect(
      shouldAutoOpenArtifact(candidate(`${CWD}/docs/proposal.md`), {
        sessionCwd: CWD,
      }),
    ).toBe(true);
  });

  // ── Gate 1: documents only ────────────────────────────────────────────
  describe("images are not auto-opened", () => {
    for (const ext of [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]) {
      it(`skips ${ext}`, () => {
        expect(
          shouldAutoOpenArtifact(candidate(`${CWD}/screenshot${ext}`), {
            sessionCwd: CWD,
          }),
        ).toBe(false);
      });
    }
  });

  it("skips non-viewable files", () => {
    expect(
      shouldAutoOpenArtifact(candidate(`${CWD}/index.ts`), { sessionCwd: CWD }),
    ).toBe(false);
  });

  // ── Gate 2: writes, not reads ─────────────────────────────────────────
  it("does not open a file the agent merely read", () => {
    expect(
      shouldAutoOpenArtifact(
        candidate(`${CWD}/README.md`, {
          toolKind: "read",
          toolName: "developer__read_file",
        }),
        { sessionCwd: CWD },
      ),
    ).toBe(false);
  });

  it("does not open on search or fetch", () => {
    for (const toolKind of ["search", "fetch", "think", "delete"]) {
      expect(
        shouldAutoOpenArtifact(
          candidate(`${CWD}/notes.md`, { toolKind, toolName: "some__tool" }),
          { sessionCwd: CWD },
        ),
      ).toBe(false);
    }
  });

  it("still opens when toolKind is absent but the tool name implies a write", () => {
    // toolKind is optional on the ACP wire, so the name is the fallback.
    expect(
      shouldAutoOpenArtifact(
        candidate(`${CWD}/notes.md`, {
          toolKind: null,
          toolName: "developer__write",
        }),
        { sessionCwd: CWD },
      ),
    ).toBe(true);
  });

  it("does not open when neither kind nor name implies a write", () => {
    expect(
      shouldAutoOpenArtifact(
        candidate(`${CWD}/notes.md`, {
          toolKind: null,
          toolName: "developer__grep",
        }),
        { sessionCwd: CWD },
      ),
    ).toBe(false);
  });

  it("treats an explicit read kind as decisive over a write-ish name", () => {
    expect(
      shouldAutoOpenArtifact(
        candidate(`${CWD}/notes.md`, {
          toolKind: "read",
          toolName: "read_and_update_cache",
        }),
        { sessionCwd: CWD },
      ),
    ).toBe(false);
  });

  // ── Gate 3: inside a place the user works ─────────────────────────────
  it("does not open a document outside the session cwd", () => {
    expect(
      shouldAutoOpenArtifact(candidate("/tmp/scratch/notes.md"), {
        sessionCwd: CWD,
      }),
    ).toBe(false);
  });

  it("does not open when the session has no cwd", () => {
    expect(shouldAutoOpenArtifact(candidate("/anywhere/notes.md"), {})).toBe(
      false,
    );
  });

  it("is not fooled by a sibling directory sharing the cwd prefix", () => {
    expect(
      shouldAutoOpenArtifact(candidate(`${CWD}-other/notes.md`), {
        sessionCwd: CWD,
      }),
    ).toBe(false);
  });

  // A projectless "general" chat has no project root: it works in the
  // artifact root instead. Checking the cwd alone silently disabled auto-open
  // for those sessions, which was a bug rather than a policy decision.
  it("opens a document in the artifact root when there is no session cwd", () => {
    expect(
      shouldAutoOpenArtifact(candidate(`${ARTIFACT_ROOT}/blog-post.md`), {
        artifactRoot: ARTIFACT_ROOT,
      }),
    ).toBe(true);
  });

  it("opens a nested document in the artifact root", () => {
    expect(
      shouldAutoOpenArtifact(candidate(`${ARTIFACT_ROOT}/drafts/post.md`), {
        artifactRoot: ARTIFACT_ROOT,
      }),
    ).toBe(true);
  });

  it("accepts either root when both are present", () => {
    const roots = { sessionCwd: CWD, artifactRoot: ARTIFACT_ROOT };
    expect(
      shouldAutoOpenArtifact(candidate(`${CWD}/in-project.md`), roots),
    ).toBe(true);
    expect(
      shouldAutoOpenArtifact(candidate(`${ARTIFACT_ROOT}/general.md`), roots),
    ).toBe(true);
    expect(shouldAutoOpenArtifact(candidate("/tmp/elsewhere.md"), roots)).toBe(
      false,
    );
  });

  it("still applies the machinery gate inside the artifact root", () => {
    expect(
      shouldAutoOpenArtifact(candidate(`${ARTIFACT_ROOT}/pr_body.md`), {
        artifactRoot: ARTIFACT_ROOT,
      }),
    ).toBe(false);
  });

  it("still applies the write gate inside the artifact root", () => {
    expect(
      shouldAutoOpenArtifact(
        candidate(`${ARTIFACT_ROOT}/notes.md`, {
          toolKind: "read",
          toolName: "read_file",
        }),
        { artifactRoot: ARTIFACT_ROOT },
      ),
    ).toBe(false);
  });

  // ── Gate 4: not agent machinery ───────────────────────────────────────
  it("does not open agent instructions written by a skill", () => {
    // The agent-browser case: a skill writes instructions for another agent.
    expect(
      shouldAutoOpenArtifact(
        candidate(`${CWD}/.agents/skills/agent-browser/SKILL.md`),
        { sessionCwd: CWD },
      ),
    ).toBe(false);
  });

  it("does not open PR copy", () => {
    for (const name of [
      "pr_body.md",
      "PR-description.md",
      "pr_copy.md",
      "COMMIT_EDITMSG",
    ]) {
      expect(
        shouldAutoOpenArtifact(candidate(`${CWD}/${name}`), {
          sessionCwd: CWD,
        }),
      ).toBe(false);
    }
  });

  it("does not open AGENTS.md or CLAUDE.md", () => {
    for (const name of ["AGENTS.md", "CLAUDE.md", "GOOSE.md"]) {
      expect(
        shouldAutoOpenArtifact(candidate(`${CWD}/${name}`), {
          sessionCwd: CWD,
        }),
      ).toBe(false);
    }
  });

  it("does not open files in machinery directories", () => {
    for (const dir of [
      ".goose",
      ".git",
      ".github",
      "node_modules",
      "dist",
      "target",
      "coverage",
    ]) {
      expect(
        shouldAutoOpenArtifact(candidate(`${CWD}/${dir}/notes.md`), {
          sessionCwd: CWD,
        }),
      ).toBe(false);
    }
  });

  it("does not treat a document whose name merely contains a machinery word as machinery", () => {
    // `target-audience.md` must survive the `target` build-dir entry, which is
    // matched as a whole path segment rather than a substring.
    expect(
      shouldAutoOpenArtifact(candidate(`${CWD}/docs/target-audience.md`), {
        sessionCwd: CWD,
      }),
    ).toBe(true);
    expect(
      shouldAutoOpenArtifact(candidate(`${CWD}/build-notes.md`), {
        sessionCwd: CWD,
      }),
    ).toBe(true);
  });

  it("handles empty paths without opening", () => {
    expect(shouldAutoOpenArtifact(candidate(""), { sessionCwd: CWD })).toBe(
      false,
    );
  });
});

describe("isWriteLikeTool", () => {
  it("accepts edit and move", () => {
    expect(isWriteLikeTool("edit", null)).toBe(true);
    expect(isWriteLikeTool("move", null)).toBe(true);
  });

  it("rejects read-ish kinds regardless of name", () => {
    expect(isWriteLikeTool("read", "write_file")).toBe(false);
  });

  it("falls back to the name for non-committal kinds", () => {
    expect(isWriteLikeTool("other", "developer__create_file")).toBe(true);
    expect(isWriteLikeTool("other", "developer__list_dir")).toBe(false);
    expect(isWriteLikeTool("execute", "developer__patch")).toBe(true);
  });

  it("returns false when there is nothing to go on", () => {
    expect(isWriteLikeTool(null, null)).toBe(false);
    expect(isWriteLikeTool(undefined, undefined)).toBe(false);
  });
});

describe("isMachineryPath", () => {
  it("tolerates windows-style separators", () => {
    expect(isMachineryPath("C:\\proj\\.agents\\skills\\SKILL.md")).toBe(true);
    expect(isMachineryPath("C:\\proj\\docs\\guide.md")).toBe(false);
  });

  it("treats an empty path as machinery (nothing to show)", () => {
    expect(isMachineryPath("")).toBe(true);
  });
});

describe("isWithinWorkRoots", () => {
  it("matches any supplied root", () => {
    expect(
      isWithinWorkRoots([CWD, ARTIFACT_ROOT], `${ARTIFACT_ROOT}/a.md`),
    ).toBe(true);
    expect(isWithinWorkRoots([CWD, ARTIFACT_ROOT], `${CWD}/a.md`)).toBe(true);
  });

  it("ignores nullish and empty roots", () => {
    expect(isWithinWorkRoots([null, undefined, ""], "/anywhere/a.md")).toBe(
      false,
    );
    expect(isWithinWorkRoots([], "/anywhere/a.md")).toBe(false);
  });

  it("treats a root as containing itself", () => {
    expect(isWithinWorkRoots([CWD], CWD)).toBe(true);
  });

  it("handles a root with a trailing slash", () => {
    expect(isWithinWorkRoots([`${CWD}/`], `${CWD}/a.md`)).toBe(true);
  });
});

describe("isWithinBase", () => {
  it("uses host-platform case semantics for Unix paths", () => {
    expect(isWithinBase("/users/dev/project", `${CWD}/a.md`, "mac")).toBe(true);
    expect(isWithinBase(CWD, "/USERS/DEV/PROJECT/a.md", "mac")).toBe(true);
    expect(isWithinBase("/users/dev/project", `${CWD}/a.md`, "linux")).toBe(
      false,
    );
    expect(isWithinBase(CWD, `${CWD}/a.md`, "linux")).toBe(true);
  });

  it("folds case for Windows drive/UNC paths", () => {
    expect(isWithinBase("C:\\Work", "c:/work/a.md")).toBe(true);
    expect(isWithinBase("\\\\server\\share", "//SERVER/SHARE/a.md")).toBe(true);
  });

  it("keeps the sibling-boundary guarantee", () => {
    expect(isWithinBase("/work", "/work-secrets/a.md")).toBe(false);
    expect(isWithinBase("C:\\Work", "C:/work-secrets/a.md")).toBe(false);
  });
});
