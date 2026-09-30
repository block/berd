import {
  beforeEach as beforeSupportedMemory,
  afterEach as afterSupportedMemory,
  vi as memoryEnv,
} from "vitest";
beforeSupportedMemory(() => memoryEnv.stubEnv("VITE_MEMORY_SUPPORTED", "1"));
afterSupportedMemory(() => memoryEnv.unstubAllEnvs());
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHomeDir: vi.fn(),
  initializeMemoryStore: vi.fn(),
  listMemoryDocuments: vi.fn(),
  readMemoryTextFile: vi.fn(),
  saveMemoryDocument: vi.fn(),
}));

vi.mock("@/shared/api/system", () => ({
  getHomeDir: mocks.getHomeDir,
  initializeMemoryStore: mocks.initializeMemoryStore,
  listMemoryDocuments: mocks.listMemoryDocuments,
  readMemoryTextFile: mocks.readMemoryTextFile,
}));
vi.mock("../saveMemoryDocument", () => ({
  saveMemoryDocument: mocks.saveMemoryDocument,
}));

import {
  createMeFile,
  loadMeFile,
  meFilePath,
  toDisplayPath,
  ME_FILE_TEMPLATE,
  saveMeFile,
} from "../meFile";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getHomeDir.mockResolvedValue("/home/u");
  mocks.saveMemoryDocument.mockResolvedValue(undefined);
});

describe("me file writes", () => {
  it("creates only ~/.me/me.md and does not automatically project memory elsewhere", async () => {
    mocks.listMemoryDocuments.mockResolvedValue([]);
    mocks.readMemoryTextFile.mockResolvedValue({ contents: ME_FILE_TEMPLATE });

    await createMeFile();

    expect(mocks.saveMemoryDocument).toHaveBeenCalledWith({
      path: "/home/u/.me/me.md",
      contents: ME_FILE_TEMPLATE,
      topic: null,
      create: true,
    });
  });

  it("saves only the user-owned memory file without automatic sharing", async () => {
    await saveMeFile("/home/u/.me/me.md", "## Preferences\n\n- Keep it brief.");

    expect(mocks.saveMemoryDocument).toHaveBeenCalledWith({
      path: "/home/u/.me/me.md",
      contents: "## Preferences\n\n- Keep it brief.",
      topic: null,
      create: false,
    });
  });

  it("documents the encrypted local-filesystem boundary in the starter file", () => {
    expect(ME_FILE_TEMPLATE).toContain("encrypted local files");
    expect(ME_FILE_TEMPLATE).toContain("not a secrets vault");
    expect(ME_FILE_TEMPLATE).toContain("not automatically copy");
  });
});

it("matches normalized backend documents and shortens Windows paths", async () => {
  const home = "C:\\Users\\someone\\";
  const path = "C:/Users/someone/.me/me.md";
  mocks.getHomeDir.mockResolvedValue(home);
  mocks.listMemoryDocuments.mockResolvedValue([
    { path, fileName: "me.md", contents: "# Me" },
  ]);
  expect(meFilePath(home)).toBe(path);
  expect(toDisplayPath("C:\\Users\\someone\\.me\\me.md", home)).toBe(
    "~/.me/me.md",
  );
  await expect(loadMeFile()).resolves.toMatchObject({
    status: "present",
    path,
    displayPath: "~/.me/me.md",
  });
});
