import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  readMemoryPolicy: vi.fn(),
  writeMemoryPolicy: vi.fn(),
}));
vi.mock("@/shared/api/system", () => mocks);
import {
  isMemoryEnabledByPolicy,
  readMemoryPolicy,
  writeMemoryPolicy,
} from "../memoryPolicyFile";
beforeEach(() => {
  vi.resetAllMocks();
});
describe("memory policy", () => {
  it.each([
    null,
    {},
    { enabled: "yes" },
  ])("fails closed for absent or malformed policy %j", async (policy) => {
    mocks.readMemoryPolicy.mockResolvedValue(policy);
    expect(await readMemoryPolicy()).toBeNull();
    expect(await isMemoryEnabledByPolicy()).toBe(false);
  });
  it("fails closed for unavailable policy", async () => {
    mocks.readMemoryPolicy.mockRejectedValue(new Error("locked"));
    expect(await isMemoryEnabledByPolicy()).toBe(false);
  });
  it.each([true, false])("reads explicit enabled %s", async (enabled) => {
    mocks.readMemoryPolicy.mockResolvedValue({
      enabled,
      arbitrary: "not retained",
    });
    expect(await readMemoryPolicy()).toEqual({ enabled });
    expect(await isMemoryEnabledByPolicy()).toBe(enabled);
  });
  it("writes only the boolean through the dedicated command", async () => {
    expect(await writeMemoryPolicy(false)).toBe(true);
    expect(mocks.writeMemoryPolicy).toHaveBeenCalledExactlyOnceWith(false);
    expect(mocks.readMemoryPolicy).not.toHaveBeenCalled();
  });
  it("reports failure rather than presenting an unpersisted switch", async () => {
    mocks.writeMemoryPolicy.mockRejectedValue(new Error("read-only"));
    expect(await writeMemoryPolicy(false)).toBe(false);
  });
});
