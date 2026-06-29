import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
} from "@/shared/runtime-config/schema";
import {
  clearFakeRuntimeConfig,
  getRuntimeConfig,
  refreshRuntimeConfig,
  setFakeRuntimeConfig,
} from "./runtimeConfig";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

const validConfig = DEFAULT_RUNTIME_CONFIG satisfies RuntimeConfig;

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
        ...validConfig,
        goose: {
          ...validConfig.goose,
          modelProviders: [
            {
              ...validConfig.goose.modelProviders[0],
              endpointEnv: { DATABRICKS_HOST: "Bearer nope" },
            },
          ],
        },
      }),
    ).rejects.toThrow(/secret-looking/);
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
