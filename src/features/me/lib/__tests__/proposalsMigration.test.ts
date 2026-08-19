import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHomeDir: vi.fn(),
  pathExists: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  createTextFile: vi.fn(),
}));

vi.mock("@/shared/api/system", () => mocks);

const OLD_DIR = "/home/u/.me/.proposals";
const NEW = (name: string) => `/home/u/.me/proposals/${name}`;

async function importFresh() {
  // The migration latches after one run, so each test needs a fresh module.
  vi.resetModules();
  return (await import("../proposalsMigration")).migrateProposalsDir;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getHomeDir.mockResolvedValue("/home/u");
});

describe("migrateProposalsDir", () => {
  it("does nothing when there is no old directory", async () => {
    mocks.pathExists.mockResolvedValue(false);
    const migrate = await importFresh();
    await migrate();
    expect(mocks.createTextFile).not.toHaveBeenCalled();
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it("carries the tombstone file to the visible directory", async () => {
    // Losing dismissed.jsonl would let deleted memories be re-added, which is
    // the one regression the delete guarantee can't afford.
    const tombstones = '{"id":"a","content":"Old fact."}\n';
    mocks.pathExists.mockImplementation(async (path: string) => {
      if (path === OLD_DIR) return true;
      if (path === `${OLD_DIR}/dismissed.jsonl`) return true;
      return false;
    });
    mocks.readTextFile.mockResolvedValue({ contents: tombstones });
    const migrate = await importFresh();
    await migrate();
    expect(mocks.createTextFile).toHaveBeenCalledWith(
      NEW("dismissed.jsonl"),
      tombstones,
    );
  });

  it("appends rather than overwriting when the new file already has entries", async () => {
    const carried = '{"id":"old"}\n';
    const existing = '{"id":"new"}\n';
    mocks.pathExists.mockImplementation(async (path: string) => {
      if (path === OLD_DIR) return true;
      if (path === `${OLD_DIR}/pending.jsonl`) return true;
      if (path === NEW("pending.jsonl")) return true;
      return false;
    });
    mocks.readTextFile.mockImplementation(async (path: string) =>
      path.includes(".proposals")
        ? { contents: carried }
        : { contents: existing },
    );
    const migrate = await importFresh();
    await migrate();
    const [, body] = mocks.writeTextFile.mock.calls[0];
    expect(body).toBe(`${existing}${carried}`);
  });

  it("does not duplicate content if it runs twice", async () => {
    const carried = '{"id":"old"}\n';
    mocks.pathExists.mockImplementation(async (path: string) => {
      if (path === OLD_DIR) return true;
      if (path === `${OLD_DIR}/pending.jsonl`) return true;
      if (path === NEW("pending.jsonl")) return true;
      return false;
    });
    mocks.readTextFile.mockResolvedValue({ contents: carried });
    const migrate = await importFresh();
    await migrate();
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it("never throws when the store is unreadable", async () => {
    mocks.pathExists.mockRejectedValue(new Error("nope"));
    const migrate = await importFresh();
    await expect(migrate()).resolves.toBeUndefined();
  });
});
