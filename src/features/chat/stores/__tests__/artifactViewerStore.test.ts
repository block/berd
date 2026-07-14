import { afterEach, describe, expect, it } from "vitest";
import { useArtifactViewerStore } from "../artifactViewerStore";

function reset() {
  useArtifactViewerStore.setState({
    openBySession: {},
    lastClosedPathBySession: {},
  });
}

describe("artifactViewerStore", () => {
  afterEach(reset);

  it("open/close tracks per-session state and records the closed path", () => {
    const { open, close } = useArtifactViewerStore.getState();
    open("s1", { resolvedPath: "/p/a.md", filename: "a.md" });
    expect(
      useArtifactViewerStore.getState().openBySession.s1?.resolvedPath,
    ).toBe("/p/a.md");

    close("s1");
    expect(useArtifactViewerStore.getState().openBySession.s1).toBeNull();
    expect(useArtifactViewerStore.getState().lastClosedPathBySession.s1).toBe(
      "/p/a.md",
    );
  });
});
