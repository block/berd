import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  getHomeDir: vi.fn(),
  listMemoryDocuments: vi.fn(),
  pathExists: vi.fn(),
  readMemoryTextFile: vi.fn(),
  saveReviewedMemoryDocument: vi.fn(),
  initializeMemoryStore: vi.fn(),
  createTextFile: vi.fn(),
}));
vi.mock("@/shared/api/system", () => mocks);
import { listTopics, createTopic } from "../meTopics";
import { listProposals } from "../meProposals";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getHomeDir.mockResolvedValue("C:\\Users\\someone\\");
});
it("lists normalized backend topic paths for Windows home directories", async () => {
  mocks.listMemoryDocuments.mockResolvedValue([
    { path: "C:/Users/someone/.me/me.md", fileName: "me.md", contents: "# Me" },
    {
      path: "C:/Users/someone/.me/topics/work.md",
      fileName: "work.md",
      contents: "# Work",
    },
  ]);
  await expect(listTopics()).resolves.toMatchObject([
    { label: "Work", path: "C:/Users/someone/.me/topics/work.md" },
  ]);
});
it("creates topics with slash-normalized paths", async () => {
  await createTopic("Travel");
  expect(mocks.createTextFile).toHaveBeenCalledWith(
    "C:/Users/someone/.me/topics/travel.md",
    expect.stringContaining("# Travel"),
  );
});
it("reads the queue through a slash-normalized path", async () => {
  mocks.pathExists.mockResolvedValue(true);
  mocks.readMemoryTextFile.mockResolvedValue({ contents: "" });
  await expect(listProposals()).resolves.toEqual([]);
  expect(mocks.pathExists).toHaveBeenCalledWith(
    "C:/Users/someone/.me/proposals/pending.jsonl",
  );
  expect(mocks.readMemoryTextFile).toHaveBeenCalledWith(
    "C:/Users/someone/.me/proposals/pending.jsonl",
  );
});
