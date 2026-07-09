import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePath } from "@/shared/api/pathResolver";
import type { ProjectInfo } from "../api/projects";
import { resolveSessionCwd } from "./sessionCwdSelection";
import {
  defaultGlobalArtifactRoot,
  resolveProjectDefaultArtifactRoot,
} from "./chatProjectContext";

vi.mock("@/shared/api/pathResolver", () => ({
  resolvePath: vi.fn(),
}));

function makeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "project-1",
    path: "/tmp/projects/project-1.md",
    name: "Project",
    description: "",
    prompt: "",
    icon: "folder",
    color: "#000000",
    projectWorkspaces: [],
    workingDirs: [],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
    ...overrides,
  };
}

describe("sessionCwdSelection", () => {
  beforeEach(() => {
    vi.mocked(resolvePath).mockReset();
    if (typeof window !== "undefined") {
      window.localStorage.clear();
    }
  });

  it("resolves the first workspace root unchanged", () => {
    expect(
      resolveProjectDefaultArtifactRoot(
        makeProject({
          workingDirs: ["/Users/wesb/dev/goose2", "/Users/wesb/dev/other"],
        }),
      ),
    ).toBe("/Users/wesb/dev/goose2");
  });

  it("returns undefined when no workspace roots exist", () => {
    expect(
      resolveProjectDefaultArtifactRoot(
        makeProject({
          workingDirs: [],
        }),
      ),
    ).toBeUndefined();
  });

  it("returns undefined for a pathless project fallback directory", () => {
    expect(
      resolveProjectDefaultArtifactRoot(
        makeProject({
          workingDirs: [],
        }),
      ),
    ).toBeUndefined();
  });

  it("falls back to the shared artifact folder for a pathless project session cwd", async () => {
    await expect(
      resolveSessionCwd(
        makeProject({
          workingDirs: [],
        }),
      ),
    ).resolves.toBe("~/goose artifacts");

    expect(resolvePath).not.toHaveBeenCalled();
  });

  describe("defaultGlobalArtifactRoot", () => {
    it("returns the default artifact root", async () => {
      await expect(defaultGlobalArtifactRoot()).resolves.toBe(
        "~/goose artifacts",
      );

      expect(resolvePath).not.toHaveBeenCalled();
    });
  });
});
