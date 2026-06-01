import { describe, expect, it } from "vitest";
import {
  createProjectArtifactMetadata,
  deriveProjectArtifactState,
} from "./deriveProjectArtifactState";

describe("deriveProjectArtifactState", () => {
  it("keeps artifact seed stable when non-identity inputs change", () => {
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
    const changedPresentation = deriveProjectArtifactState({
      ...baseInput,
      prompt:
        "Coordinate release readiness with a much longer brief and rollout notes.",
      workingDirs: ["/tmp/launch-site", "/tmp/launch-site/packages/app"],
      sessionCount: 12,
      color: "peach",
    });

    expect(changedPresentation.seed).toBe(blue.seed);
    expect(changedPresentation.accentColor).not.toBe(blue.accentColor);
  });

  it("changes artifact seed when project name changes", () => {
    const baseInput = {
      projectId: "project-1",
      name: "Launch Site",
      prompt: "Coordinate release readiness.",
      workingDirs: ["/tmp/launch-site"],
      sessionCount: 2,
      color: "blue",
    };

    expect(
      deriveProjectArtifactState({
        ...baseInput,
        prompt: "Coordinate release readiness with extra scope.",
      }).seed,
    ).toBe(deriveProjectArtifactState(baseInput).seed);
    expect(
      deriveProjectArtifactState({
        ...baseInput,
        name: "Launch Platform",
      }).seed,
    ).not.toBe(deriveProjectArtifactState(baseInput).seed);
  });

  it("creates metadata from project id and normalized name only", () => {
    const baseInput = {
      projectId: "project-1",
      name: "  Launch Site  ",
      prompt: "Coordinate release readiness.",
      color: "blue",
      workingDirs: ["/tmp/launch-site"],
      sessionCount: 2,
    };

    const metadata = createProjectArtifactMetadata(baseInput);
    const changedMetadata = createProjectArtifactMetadata({
      ...baseInput,
      name: "Launch Site",
      prompt: "Different prompt.",
      workingDirs: ["/tmp/other"],
      sessionCount: 20,
      color: "peach",
    });

    expect(changedMetadata.seed).toBe(metadata.seed);
    expect(changedMetadata.color).toBe("peach");
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
