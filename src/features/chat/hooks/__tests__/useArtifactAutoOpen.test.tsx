import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionArtifact } from "@/features/chat/hooks/ArtifactPolicyContext";
import { useArtifactViewerStore } from "@/features/chat/stores/artifactViewerStore";
import { setArtifactAutoOpen } from "@/features/chat/lib/artifactAutoOpenPreference";

let artifactList: SessionArtifact[] = [];

vi.mock("@/features/chat/hooks/ArtifactPolicyContext", () => ({
  useSessionArtifacts: () => artifactList,
}));

// Import after the mock is registered.
import { useArtifactAutoOpen } from "../useArtifactAutoOpen";

function md(
  path: string,
  lastTouchedAt: number,
  versionCount = 1,
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
  };
}

function resetStore() {
  useArtifactViewerStore.setState({
    openBySession: {},
    lastClosedPathBySession: {},
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
    renderHook(() => useArtifactAutoOpen("s1"));
    expect(
      useArtifactViewerStore.getState().openBySession.s1 ?? null,
    ).toBeNull();
  });

  it("does not auto-open a reloaded transcript that arrives while history is loading", () => {
    // Mount with an empty list and history still loading, then the past
    // transcript streams in — it must be absorbed by the baseline.
    artifactList = [];
    const { rerender } = renderHook(
      ({ loading }) => useArtifactAutoOpen("s1", loading),
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

  it("auto-opens a newly appearing viewable file", () => {
    artifactList = [md("/p/old.md", OLD)];
    const { rerender } = renderHook(() => useArtifactAutoOpen("s1"));
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
    const { rerender } = renderHook(() => useArtifactAutoOpen("s1"));
    artifactList = [md("/p/mid-run.md", OLD)];
    rerender();
    expect(
      useArtifactViewerStore.getState().openBySession.s1?.resolvedPath,
    ).toBe("/p/mid-run.md");
  });

  it("treats a new version of a known file as a live appearance", () => {
    artifactList = [md("/p/doc.md", OLD, 1)];
    const { rerender } = renderHook(() => useArtifactAutoOpen("s1"));
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
    const { rerender } = renderHook(() => useArtifactAutoOpen("s1"));
    artifactList = [md("/p/new.md", OLD + 5)];
    rerender();
    expect(
      useArtifactViewerStore.getState().openBySession.s1 ?? null,
    ).toBeNull();
  });

  it("respects a manual close: does not re-pop the same path", () => {
    artifactList = [md("/p/old.md", OLD)];
    const { rerender } = renderHook(() => useArtifactAutoOpen("s1"));

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
    const { rerender } = renderHook(() => useArtifactAutoOpen("s1"));

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
});
