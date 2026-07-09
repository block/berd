import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "../../api/projects";
import { checkDirectory, findMissingProjectDirs } from "../missingProjectDirs";

const resolvePath = vi.fn();
const checkDirectoriesExist = vi.fn();

vi.mock("@/shared/api/pathResolver", () => ({
  resolvePath: (...args: unknown[]) => resolvePath(...args),
  checkDirectoriesExist: (...args: unknown[]) => checkDirectoriesExist(...args),
}));

function makeProject(workingDirs: string[]): ProjectInfo {
  return {
    id: "project-1",
    path: "/projects/project-1",
    name: "Project",
    description: "",
    prompt: "",
    icon: "",
    color: "",
    projectWorkspaces: [],
    workingDirs,
    useWorktrees: false,
    order: 0,
    archivedAt: null,
  };
}

describe("findMissingProjectDirs", () => {
  beforeEach(() => {
    resolvePath.mockReset();
    checkDirectoriesExist.mockReset();
    resolvePath.mockImplementation(({ parts }: { parts: string[] }) =>
      Promise.resolve({ path: `/resolved${parts[0]}` }),
    );
  });

  it("returns an empty list when the project has no working dirs", async () => {
    const result = await findMissingProjectDirs(makeProject(["  ", ""]));
    expect(result).toEqual([]);
    expect(checkDirectoriesExist).not.toHaveBeenCalled();
  });

  it("resolves every working dir and reports the missing ones", async () => {
    checkDirectoriesExist.mockResolvedValue(["/resolved/b"]);

    const result = await findMissingProjectDirs(makeProject(["/a", " /b "]));

    expect(resolvePath).toHaveBeenCalledTimes(2);
    expect(checkDirectoriesExist).toHaveBeenCalledWith([
      "/resolved/a",
      "/resolved/b",
    ]);
    expect(result).toEqual(["/resolved/b"]);
  });

  it("returns an empty list when all dirs exist", async () => {
    checkDirectoriesExist.mockResolvedValue([]);
    const result = await findMissingProjectDirs(makeProject(["/a"]));
    expect(result).toEqual([]);
  });
});

describe("checkDirectory", () => {
  beforeEach(() => {
    resolvePath.mockReset();
    checkDirectoriesExist.mockReset();
    resolvePath.mockImplementation(({ parts }: { parts: string[] }) =>
      Promise.resolve({ path: `/resolved${parts[0]}` }),
    );
  });

  it("returns null for empty input", async () => {
    expect(await checkDirectory("  ")).toBeNull();
    expect(resolvePath).not.toHaveBeenCalled();
    expect(checkDirectoriesExist).not.toHaveBeenCalled();
  });

  it("resolves and checks a cwd", async () => {
    checkDirectoriesExist.mockResolvedValue([]);

    const result = await checkDirectory("/a");

    expect(resolvePath).toHaveBeenCalledWith({ parts: ["/a"] });
    expect(checkDirectoriesExist).toHaveBeenCalledWith(["/resolved/a"]);
    expect(result).toEqual({ resolvedPath: "/resolved/a", missing: false });
  });

  it("reports a missing directory with its resolved path", async () => {
    checkDirectoriesExist.mockResolvedValue(["/resolved/a"]);

    await expect(checkDirectory("/a")).resolves.toEqual({
      resolvedPath: "/resolved/a",
      missing: true,
    });
  });

  it("treats a failed check as present", async () => {
    checkDirectoriesExist.mockRejectedValue(new Error("check failed"));

    await expect(checkDirectory("/a")).resolves.toEqual({
      resolvedPath: "/resolved/a",
      missing: false,
    });
  });
});
