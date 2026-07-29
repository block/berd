import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionArtifact } from "@/features/chat/hooks/ArtifactPolicyContext";
import { useArtifactViewerStore } from "@/features/chat/stores/artifactViewerStore";
import { setArtifactAutoOpen } from "@/features/chat/lib/artifactAutoOpenPreference";
import { useChatStore } from "@/features/chat/stores/chatStore";

let artifactList: SessionArtifact[] = [];

vi.mock("@/features/chat/hooks/ArtifactPolicyContext", () => ({
  useSessionArtifacts: () => artifactList,
}));

// Import after the mock is registered.
import { useArtifactAutoOpen } from "../useArtifactAutoOpen";

/** Session cwd all fixtures live under, so the scope gate passes. */
const CWD = "/p";

function md(
  path: string,
  lastTouchedAt: number,
  versionCount = 1,
  overrides: Partial<SessionArtifact> = {},
): SessionArtifact {
  return {
    resolvedPath: path,
    displayPath: path,
    filename: path.split("/").pop() ?? path,
    directoryPath: "",
    resolvedDirectoryPath: "",
    versionCount,
    lastTouchedAt,
    kind: "file",
    toolName: "write_file",
    toolKind: "edit",
    ...overrides,
  };
}

function resetStore() {
  useArtifactViewerStore.setState({
    openBySession: {},
    lastClosedPathBySession: {},
  });
  // Run state is global; clear it so a run id can't leak between tests.
  // Wrapped in act because a still-mounted hook subscribes to this selector.
  act(() => {
    useChatStore.getState().setActiveRunId("s1", null);
  });
}

/** Set the active run inside act(), since it drives a subscribed selector. */
function setRun(runId: string | null) {
  act(() => {
    useChatStore.getState().setActiveRunId("s1", runId);
  });
}

const OLD = 1_000;

describe("useArtifactAutoOpen", () => {
  beforeEach(() => {
    localStorage.clear();
    artifactList = [];
    resetStore();
  });
  afterEach(() => {
    localStorage.clear();
    resetStore();
  });

  it("does not auto-open pre-existing artifacts on mount (past chat)", () => {
    artifactList = [md("/p/notes.md", OLD)];
    renderHook(() => useArtifactAutoOpen("s1", false, { sessionCwd: CWD }));
    expect(
      useArtifactViewerStore.getState().openBySession.s1 ?? null,
    ).toBeNull();
  });

  it("does not auto-open a reloaded transcript that arrives while history is loading", () => {
    // Mount with an empty list and history still loading, then the past
    // transcript streams in — it must be absorbed by the baseline.
    artifactList = [];
    const { rerender } = renderHook(
      ({ loading }) => useArtifactAutoOpen("s1", loading, { sessionCwd: CWD }),
      { initialProps: { loading: true } },
    );
    artifactList = [md("/p/reloaded.md", OLD)];
    rerender({ loading: true });
    // History settles; baseline closes without opening.
    rerender({ loading: false });
    expect(
      useArtifactViewerStore.getState().openBySession.s1 ?? null,
    ).toBeNull();
  });

  it("does not auto-open history when loading starts after the first settled pass", () => {
    // On the first session open after app startup, ChatView can mount before
    // activation marks the transcript replay as loading.
    artifactList = [];
    const { rerender } = renderHook(
      ({ loading }) => useArtifactAutoOpen("s1", loading, { sessionCwd: CWD }),
      { initialProps: { loading: false } },
    );

    rerender({ loading: true });
    artifactList = [md("/p/reloaded.md", OLD)];
    // Replay messages are committed just before the loading flag is cleared.
    rerender({ loading: false });

    expect(
      useArtifactViewerStore.getState().openBySession.s1 ?? null,
    ).toBeNull();
  });

  it("auto-opens a newly appearing viewable file", () => {
    artifactList = [md("/p/old.md", OLD)];
    const { rerender } = renderHook(() =>
      useArtifactAutoOpen("s1", false, { sessionCwd: CWD }),
    );
    // A new file appears after the baseline.
    artifactList = [md("/p/new.md", OLD + 5), md("/p/old.md", OLD)];
    rerender();
    expect(
      useArtifactViewerStore.getState().openBySession.s1?.resolvedPath,
    ).toBe("/p/new.md");
  });

  it("auto-opens a live write even when its message timestamp is old (mid-run join)", () => {
    // The Builderbot P2 scenario: tool_call_update patches a location onto an
    // assistant message that keeps its original created time. The artifact's
    // lastTouchedAt is OLD, but it APPEARS after the baseline — it must open.
    artifactList = [];
    const { rerender } = renderHook(() =>
      useArtifactAutoOpen("s1", false, { sessionCwd: CWD }),
    );
    artifactList = [md("/p/mid-run.md", OLD)];
    rerender();
    expect(
      useArtifactViewerStore.getState().openBySession.s1?.resolvedPath,
    ).toBe("/p/mid-run.md");
  });

  it("treats a new version of a known file as a live appearance", () => {
    artifactList = [md("/p/doc.md", OLD, 1)];
    const { rerender } = renderHook(() =>
      useArtifactAutoOpen("s1", false, { sessionCwd: CWD }),
    );
    // Same path, same message time, but the version count advanced.
    artifactList = [md("/p/doc.md", OLD, 2)];
    rerender();
    expect(
      useArtifactViewerStore.getState().openBySession.s1?.resolvedPath,
    ).toBe("/p/doc.md");
  });

  it("does not auto-open when the preference is off", () => {
    setArtifactAutoOpen(false);
    artifactList = [md("/p/old.md", OLD)];
    const { rerender } = renderHook(() =>
      useArtifactAutoOpen("s1", false, { sessionCwd: CWD }),
    );
    artifactList = [md("/p/new.md", OLD + 5)];
    rerender();
    expect(
      useArtifactViewerStore.getState().openBySession.s1 ?? null,
    ).toBeNull();
  });

  it("respects a manual close: does not re-pop the same path", () => {
    artifactList = [md("/p/old.md", OLD)];
    const { rerender } = renderHook(() =>
      useArtifactAutoOpen("s1", false, { sessionCwd: CWD }),
    );

    // New file opens.
    artifactList = [md("/p/new.md", OLD + 5)];
    rerender();
    expect(
      useArtifactViewerStore.getState().openBySession.s1?.resolvedPath,
    ).toBe("/p/new.md");

    // User closes it.
    useArtifactViewerStore.getState().close("s1");

    // Same file re-touched (new version) -> should stay closed.
    artifactList = [md("/p/new.md", OLD + 6, 2)];
    rerender();
    expect(
      useArtifactViewerStore.getState().openBySession.s1 ?? null,
    ).toBeNull();
  });

  it("opens a different file even after a manual close", () => {
    artifactList = [md("/p/a.md", OLD)];
    const { rerender } = renderHook(() =>
      useArtifactAutoOpen("s1", false, { sessionCwd: CWD }),
    );

    artifactList = [md("/p/a.md", OLD + 5, 2)];
    rerender();
    useArtifactViewerStore.getState().close("s1");

    // A different viewable file appears.
    artifactList = [md("/p/b.md", OLD + 6), md("/p/a.md", OLD + 5, 2)];
    rerender();
    expect(
      useArtifactViewerStore.getState().openBySession.s1?.resolvedPath,
    ).toBe("/p/b.md");
  });
  // ── Root race (projectless chats) ─────────────────────────────────────
  it("re-evaluates an artifact that appeared before the artifact root resolved", () => {
    // Projectless chats get their artifact root asynchronously (IPC resolve).
    // A document written in that window must NOT be consumed by a policy that
    // cannot yet say yes — it must open once the root arrives.
    artifactList = [];
    const { rerender } = renderHook(
      ({ roots }) => useArtifactAutoOpen("s1", false, roots),
      { initialProps: { roots: {} as { artifactRoot?: string | null } } },
    );

    // Artifact appears while no root is known.
    artifactList = [md("/p/report.md", OLD + 1)];
    rerender({ roots: {} });
    expect(
      useArtifactViewerStore.getState().openBySession.s1 ?? null,
    ).toBeNull();

    // Root resolves; the still-fresh artifact must now open.
    rerender({ roots: { artifactRoot: "/p" } });
    expect(
      useArtifactViewerStore.getState().openBySession.s1?.resolvedPath,
    ).toBe("/p/report.md");
  });

  it("still absorbs the pre-root backlog into the baseline on reload", () => {
    // The root-race fix must not weaken the history guarantee: artifacts
    // present before the baseline settles never replay, roots or no roots.
    artifactList = [md("/p/old.md", OLD)];
    const { rerender } = renderHook(
      ({ roots }) => useArtifactAutoOpen("s1", false, roots),
      { initialProps: { roots: {} as { artifactRoot?: string | null } } },
    );

    rerender({ roots: { artifactRoot: "/p" } });
    expect(
      useArtifactViewerStore.getState().openBySession.s1 ?? null,
    ).toBeNull();
  });

  it("does not replay a backlog gathered while the preference was off", () => {
    // Guards the ordering of the disabled-absorb vs. roots-wait branches: a
    // disabled hook must consume fresh artifacts even when no root is known,
    // or enabling the preference later would replay them.
    setArtifactAutoOpen(false);
    artifactList = [];
    const { rerender } = renderHook(
      ({ roots }) => useArtifactAutoOpen("s1", false, roots),
      { initialProps: { roots: {} as { artifactRoot?: string | null } } },
    );

    artifactList = [md("/p/while-off.md", OLD + 1)];
    rerender({ roots: {} });

    act(() => {
      setArtifactAutoOpen(true);
    });
    rerender({ roots: { artifactRoot: "/p" } });
    expect(
      useArtifactViewerStore.getState().openBySession.s1 ?? null,
    ).toBeNull();
  });

  // ── Importance policy (issue 1: "it opens too often") ────────────────
  it("does not auto-open a file the agent only read", () => {
    artifactList = [];
    const { rerender } = renderHook(() =>
      useArtifactAutoOpen("s1", false, { sessionCwd: CWD }),
    );
    artifactList = [
      md("/p/README.md", OLD, 1, { toolKind: "read", toolName: "read_file" }),
    ];
    rerender();
    expect(
      useArtifactViewerStore.getState().openBySession.s1 ?? null,
    ).toBeNull();
  });

  it("does not auto-open a screenshot", () => {
    artifactList = [];
    const { rerender } = renderHook(() =>
      useArtifactAutoOpen("s1", false, { sessionCwd: CWD }),
    );
    artifactList = [md("/p/shot.png", OLD)];
    rerender();
    expect(
      useArtifactViewerStore.getState().openBySession.s1 ?? null,
    ).toBeNull();
  });

  it("does not auto-open agent machinery (skill instructions, PR copy)", () => {
    artifactList = [];
    const { rerender } = renderHook(() =>
      useArtifactAutoOpen("s1", false, { sessionCwd: CWD }),
    );
    artifactList = [
      md("/p/.agents/skills/agent-browser/SKILL.md", OLD + 1),
      md("/p/pr_body.md", OLD + 2),
    ];
    rerender();
    expect(
      useArtifactViewerStore.getState().openBySession.s1 ?? null,
    ).toBeNull();
  });

  it("does not auto-open a document outside the session cwd", () => {
    artifactList = [];
    const { rerender } = renderHook(() =>
      useArtifactAutoOpen("s1", false, { sessionCwd: CWD }),
    );
    artifactList = [md("/tmp/scratch.md", OLD)];
    rerender();
    expect(
      useArtifactViewerStore.getState().openBySession.s1 ?? null,
    ).toBeNull();
  });

  it("picks the qualifying document out of a mixed batch", () => {
    artifactList = [];
    const { rerender } = renderHook(() =>
      useArtifactAutoOpen("s1", false, { sessionCwd: CWD }),
    );
    artifactList = [
      md("/p/shot.png", OLD + 3),
      md("/p/.agents/SKILL.md", OLD + 2),
      md("/p/report.md", OLD + 1),
    ];
    rerender();
    expect(
      useArtifactViewerStore.getState().openBySession.s1?.resolvedPath,
    ).toBe("/p/report.md");
  });

  // ── One auto-open per run ─────────────────────────────────────────────
  it("auto-opens only once per run when several documents are written", () => {
    setRun("run-1");
    artifactList = [];
    const { rerender } = renderHook(() =>
      useArtifactAutoOpen("s1", false, { sessionCwd: CWD }),
    );

    artifactList = [md("/p/first.md", OLD + 1)];
    rerender();
    expect(
      useArtifactViewerStore.getState().openBySession.s1?.resolvedPath,
    ).toBe("/p/first.md");

    // A second document in the SAME run must not steal the panel.
    artifactList = [md("/p/second.md", OLD + 2), md("/p/first.md", OLD + 1)];
    rerender();
    expect(
      useArtifactViewerStore.getState().openBySession.s1?.resolvedPath,
    ).toBe("/p/first.md");
  });

  it("auto-opens again on a new run", () => {
    setRun("run-1");
    artifactList = [];
    const { rerender } = renderHook(() =>
      useArtifactAutoOpen("s1", false, { sessionCwd: CWD }),
    );
    artifactList = [md("/p/first.md", OLD + 1)];
    rerender();

    // Next run: a fresh document is allowed to open.
    setRun("run-2");
    rerender();
    artifactList = [md("/p/second.md", OLD + 2), md("/p/first.md", OLD + 1)];
    rerender();
    expect(
      useArtifactViewerStore.getState().openBySession.s1?.resolvedPath,
    ).toBe("/p/second.md");
  });
});
