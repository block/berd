import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHomeDir: vi.fn(),
  pathExists: vi.fn(),
  readTextFile: vi.fn(),
  saveMemoryDocument: vi.fn(),
}));

vi.mock("@/shared/api/system", () => ({
  getHomeDir: mocks.getHomeDir,
  pathExists: mocks.pathExists,
  readTextFile: mocks.readTextFile,
}));
vi.mock("../saveMemoryDocument", () => ({
  saveMemoryDocument: mocks.saveMemoryDocument,
}));

import { createMeFile, ME_FILE_TEMPLATE, saveMeFile } from "../meFile";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getHomeDir.mockResolvedValue("/home/u");
  mocks.saveMemoryDocument.mockResolvedValue(undefined);
});

describe("me file writes", () => {
  it("creates only ~/.me/me.md and does not automatically project memory elsewhere", async () => {
    mocks.pathExists.mockResolvedValue(false);
    mocks.readTextFile.mockResolvedValue({ contents: ME_FILE_TEMPLATE });

    await createMeFile();

    expect(mocks.saveMemoryDocument).toHaveBeenCalledWith({
      path: "/home/u/.me/me.md",
      contents: ME_FILE_TEMPLATE,
      topic: null,
    });
  });

  it("saves only the user-owned memory file without automatic sharing", async () => {
    await saveMeFile("/home/u/.me/me.md", "## Preferences\n\n- Keep it brief.");

    expect(mocks.saveMemoryDocument).toHaveBeenCalledWith({
      path: "/home/u/.me/me.md",
      contents: "## Preferences\n\n- Keep it brief.",
      topic: null,
    });
  });

  it("documents the plaintext local-filesystem boundary in the starter file", () => {
    expect(ME_FILE_TEMPLATE).toContain("plaintext Markdown");
    expect(ME_FILE_TEMPLATE).toContain("not a secrets vault");
    expect(ME_FILE_TEMPLATE).toContain("not automatically copy");
  });
});
