import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RUNTIME_CONFIG, type RuntimeConfig } from "./schema";
import { useRuntimeConfigStore } from "./runtimeConfigStore";

const nextConfig: RuntimeConfig = {
  ...DEFAULT_RUNTIME_CONFIG,
  customer: { id: "block" },
};

vi.mock("@/shared/api/runtimeConfig", () => ({
  getRuntimeConfig: vi.fn(async () => ({
    status: "ready",
    source: "endpoint",
    config: nextConfig,
  })),
  refreshRuntimeConfig: vi.fn(async () => ({
    status: "ready",
    source: "endpoint",
    config: nextConfig,
  })),
  setFakeRuntimeConfig: vi.fn(async (config: RuntimeConfig) => ({
    status: "ready",
    source: "fakeEndpoint",
    config,
  })),
  clearFakeRuntimeConfig: vi.fn(async () => ({
    status: "ready",
    source: "appDefault",
    config: DEFAULT_RUNTIME_CONFIG,
  })),
}));

describe("runtimeConfigStore", () => {
  beforeEach(() => {
    useRuntimeConfigStore.setState({
      loaded: false,
      result: {
        status: "ready",
        source: "appDefault",
        config: DEFAULT_RUNTIME_CONFIG,
      },
      config: DEFAULT_RUNTIME_CONFIG,
    });
  });

  it("loads runtime config", async () => {
    await useRuntimeConfigStore.getState().load();
    expect(useRuntimeConfigStore.getState().config).toEqual(nextConfig);
  });

  it("falls back to default config for unavailable results", () => {
    useRuntimeConfigStore.getState().setResult({
      status: "unavailable",
      source: "endpoint",
      reason: "missing",
      message: "missing",
    });
    expect(useRuntimeConfigStore.getState().config).toEqual(
      DEFAULT_RUNTIME_CONFIG,
    );
  });
});
