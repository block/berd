import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHomeDir: vi.fn(),
  pathExists: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  createTextFile: vi.fn(),
}));

vi.mock("@/shared/api/system", () => mocks);

import { readMemoryPolicy, writeMemoryPolicy } from "../memoryPolicyFile";

const POLICY = "/home/u/.me/policy.json";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getHomeDir.mockResolvedValue("/home/u");
});

describe("readMemoryPolicy", () => {
  it("returns null when there is no policy file", async () => {
    // Absence means "no opinion", which is different from disabled — Berd's
    // own preference decides in that case.
    mocks.pathExists.mockResolvedValue(false);
    expect(await readMemoryPolicy()).toBeNull();
  });

  it("reads the enabled flag from the store", async () => {
    mocks.pathExists.mockResolvedValue(true);
    mocks.readTextFile.mockResolvedValue({
      contents: JSON.stringify({ enabled: false }),
    });
    expect(await readMemoryPolicy()).toEqual({ enabled: false });
  });

  it("ignores a policy file that doesn't state enabled", async () => {
    mocks.pathExists.mockResolvedValue(true);
    mocks.readTextFile.mockResolvedValue({
      contents: JSON.stringify({ somethingElse: true }),
    });
    expect(await readMemoryPolicy()).toBeNull();
  });

  it("survives unparseable policy written by another tool", async () => {
    mocks.pathExists.mockResolvedValue(true);
    mocks.readTextFile.mockResolvedValue({ contents: "not json" });
    expect(await readMemoryPolicy()).toBeNull();
  });
});

describe("writeMemoryPolicy", () => {
  it("creates the policy file when the store has none", async () => {
    mocks.pathExists.mockResolvedValue(false);
    await writeMemoryPolicy(false);
    expect(mocks.createTextFile).toHaveBeenCalledWith(
      POLICY,
      expect.stringContaining('"enabled": false'),
    );
  });

  it("preserves keys another host put in the policy", async () => {
    // Two hosts share one store, so a round trip through Berd must not drop
    // fields it doesn't understand.
    mocks.pathExists.mockResolvedValue(true);
    mocks.readTextFile.mockResolvedValue({
      contents: JSON.stringify({ enabled: true, audiences: ["work"] }),
    });
    await writeMemoryPolicy(false);
    const [, body] = mocks.writeTextFile.mock.calls[0];
    const written = JSON.parse(body as string);
    expect(written).toEqual({ enabled: false, audiences: ["work"] });
  });

  it("never throws when the store is unwritable", async () => {
    mocks.pathExists.mockResolvedValue(true);
    mocks.readTextFile.mockResolvedValue({
      contents: JSON.stringify({ enabled: true }),
    });
    mocks.writeTextFile.mockRejectedValue(new Error("read-only"));
    await expect(writeMemoryPolicy(false)).resolves.toBeUndefined();
  });
});
