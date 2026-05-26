import { describe, expect, it } from "vitest";
import { deriveProjectArtifactState } from "./deriveProjectArtifactState";

describe("deriveProjectArtifactState", () => {
  it("keeps artifact identity stable when only the project color changes", () => {
    const baseInput = {
      projectId: "project-1",
      name: "Launch Site",
      prompt: "Coordinate release readiness.",
      workingDirs: ["/tmp/launch-site"],
      sessionCount: 2,
    };

    const blue = deriveProjectArtifactState({
      ...baseInput,
      color: "blue",
    });
    const peach = deriveProjectArtifactState({
      ...baseInput,
      color: "peach",
    });

    expect(peach.seed).toBe(blue.seed);
    expect(peach.mood).toBe(blue.mood);
    expect(peach.contentMode).toBe(blue.contentMode);
    expect(peach.accentColor).not.toBe(blue.accentColor);
  });

  it("uses saved artifact metadata for visual identity", () => {
    const state = deriveProjectArtifactState({
      projectId: "project-1",
      name: "Launch Site",
      prompt: "Coordinate release readiness.",
      color: "blue",
      workingDirs: ["/tmp/launch-site"],
      sessionCount: 12,
      artifact: {
        seed: 1234,
        color: "peach",
        mood: "serene",
        moodIntensity: 0.42,
        contentMode: "cubeStatic",
      },
    });

    expect(state.seed).toBe(1234);
    expect(state.contentMode).toBe("cubeStatic");
    expect(state.mood).toBe("serene");
    expect(state.moodIntensity).toBe(0.42);
    expect(state.accentColor).toBe("#f5c7a5");
  });
});
