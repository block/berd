import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHomeDir: vi.fn(),
  pathExists: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  createTextFile: vi.fn(),
}));

vi.mock("@/shared/api/system", () => mocks);

import {
  isMemoryEnabledByPolicy,
  readMemoryPolicy,
  writeMemoryPolicy,
} from "../memoryPolicyFile";

const POLICY = "/home/u/.me/policy.json";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getHomeDir.mockResolvedValue("/home/u");
});

describe("readMemoryPolicy", () => {
  it("returns null when there is no policy file", async () => {
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

describe("isMemoryEnabledByPolicy", () => {
  it("defaults off when policy is missing", async () => {
    mocks.pathExists.mockResolvedValue(false);
    await expect(isMemoryEnabledByPolicy()).resolves.toBe(false);
  });

  it("defaults off when policy is malformed", async () => {
    mocks.pathExists.mockResolvedValue(true);
    mocks.readTextFile.mockResolvedValue({ contents: "not json" });
    await expect(isMemoryEnabledByPolicy()).resolves.toBe(false);
  });

  it("only enables memory for explicit enabled true", async () => {
    mocks.pathExists.mockResolvedValue(true);
    mocks.readTextFile.mockResolvedValue({
      contents: JSON.stringify({ enabled: true }),
    });
    await expect(isMemoryEnabledByPolicy()).resolves.toBe(true);

    mocks.readTextFile.mockResolvedValue({
      contents: JSON.stringify({ enabled: false }),
    });
    await expect(isMemoryEnabledByPolicy()).resolves.toBe(false);
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
    await expect(writeMemoryPolicy(false)).resolves.toBe(false);
  });
});
