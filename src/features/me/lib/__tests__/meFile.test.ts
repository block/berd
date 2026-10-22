import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHomeDir: vi.fn(),
  pathExists: vi.fn(),
  readTextFile: vi.fn(),
  createTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock("@/shared/api/system", () => mocks);

import { createMeFile, ME_FILE_TEMPLATE, saveMeFile } from "../meFile";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getHomeDir.mockResolvedValue("/home/u");
});

describe("me file writes", () => {
  it("creates only ~/.me/me.md and does not automatically project memory elsewhere", async () => {
    mocks.pathExists.mockResolvedValue(false);
    mocks.readTextFile.mockResolvedValue({ contents: ME_FILE_TEMPLATE });

    await createMeFile();

    expect(mocks.createTextFile).toHaveBeenCalledTimes(1);
    expect(mocks.createTextFile).toHaveBeenCalledWith(
      "/home/u/.me/me.md",
      ME_FILE_TEMPLATE,
    );
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it("saves only the user-owned memory file without automatic sharing", async () => {
    await saveMeFile("/home/u/.me/me.md", "## Preferences\n\n- Keep it brief.");

    expect(mocks.writeTextFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeTextFile).toHaveBeenCalledWith(
      "/home/u/.me/me.md",
      "## Preferences\n\n- Keep it brief.",
    );
    expect(mocks.createTextFile).not.toHaveBeenCalled();
  });

  it("documents the plaintext local-filesystem boundary in the starter file", () => {
    expect(ME_FILE_TEMPLATE).toContain("plaintext Markdown");
    expect(ME_FILE_TEMPLATE).toContain("not a secrets vault");
    expect(ME_FILE_TEMPLATE).toContain("not automatically copy");
  });
});
