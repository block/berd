import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearFakeRuntimeConfig,
  getRuntimeConfig,
  refreshRuntimeConfig,
  setFakeRuntimeConfig,
} from "./runtimeConfig";
import type { RuntimeConfig } from "@/shared/runtime-config/schema";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

const validConfig = {
  schemaVersion: 1,
  providerAllowlist: ["openai"],
} satisfies RuntimeConfig;

describe("runtime config api", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("loads runtime config through the native command", async () => {
    const result = {
      status: "ready",
      source: "fakeEndpoint",
      config: validConfig,
    };
    mockInvoke.mockResolvedValueOnce(result);

    await expect(getRuntimeConfig()).resolves.toEqual(result);
    expect(mockInvoke).toHaveBeenCalledWith("get_runtime_config");
  });

  it("refreshes runtime config through the native command", async () => {
    const result = {
      status: "unavailable",
      source: "fakeEndpoint",
      reason: "missing",
      message: "No fake response",
    };
    mockInvoke.mockResolvedValueOnce(result);

    await expect(refreshRuntimeConfig()).resolves.toEqual(result);
    expect(mockInvoke).toHaveBeenCalledWith("refresh_runtime_config");
  });

  it("validates fake config before persisting it", async () => {
    const result = {
      status: "ready",
      source: "fakeEndpoint",
      config: validConfig,
    };
    mockInvoke.mockResolvedValueOnce(result);

    await expect(setFakeRuntimeConfig(validConfig)).resolves.toEqual(result);
    expect(mockInvoke).toHaveBeenCalledWith("set_fake_runtime_config", {
      config: validConfig,
    });

    mockInvoke.mockReset();
    await expect(
      setFakeRuntimeConfig({
        schemaVersion: 1,
        providerAllowlist: ["openai", " openai "],
      } as RuntimeConfig),
    ).rejects.toThrow(/providerAllowlist must not contain duplicates/);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("clears fake runtime config through the native command", async () => {
    const result = {
      status: "unavailable",
      source: "fakeEndpoint",
      reason: "missing",
      message: "No fake response",
    };
    mockInvoke.mockResolvedValueOnce(result);

    await expect(clearFakeRuntimeConfig()).resolves.toEqual(result);
    expect(mockInvoke).toHaveBeenCalledWith("clear_fake_runtime_config");
  });
});
