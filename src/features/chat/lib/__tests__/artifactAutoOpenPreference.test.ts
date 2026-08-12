import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARTIFACT_AUTO_OPEN_STORAGE_KEY,
  getArtifactAutoOpen,
  setArtifactAutoOpen,
} from "../artifactAutoOpenPreference";

describe("artifactAutoOpenPreference", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to on when unset", () => {
    expect(getArtifactAutoOpen()).toBe(true);
  });

  it("persists disabled state", () => {
    setArtifactAutoOpen(false);
    expect(localStorage.getItem(ARTIFACT_AUTO_OPEN_STORAGE_KEY)).toBe("false");
    expect(getArtifactAutoOpen()).toBe(false);
  });

  it("re-enables", () => {
    setArtifactAutoOpen(false);
    setArtifactAutoOpen(true);
    expect(getArtifactAutoOpen()).toBe(true);
  });

  it("treats unknown stored values as on", () => {
    localStorage.setItem(ARTIFACT_AUTO_OPEN_STORAGE_KEY, "garbage");
    expect(getArtifactAutoOpen()).toBe(true);
  });
});
