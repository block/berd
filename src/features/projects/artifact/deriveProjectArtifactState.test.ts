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
});
