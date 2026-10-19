import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRuntimeConfig,
  refreshRuntimeConfigForNewChat,
} from "@/shared/api/runtimeConfig";
import type { RuntimeConfigLoadResult } from "./schema";
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
  refreshRuntimeConfigForNewChat: vi.fn(),
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
    vi.clearAllMocks();
    useRuntimeConfigStore.getState().setResult({
      status: "ready",
      source: "appDefault",
      config: DEFAULT_RUNTIME_CONFIG,
    });
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
  function deferred() {
    let resolve!: (result: RuntimeConfigLoadResult) => void;
    const promise = new Promise<RuntimeConfigLoadResult>((finish) => {
      resolve = finish;
    });
    return { promise, resolve };
  }

  const ready = (config = nextConfig): RuntimeConfigLoadResult => ({
    status: "ready",
    source: "bundledFile",
    config,
  });

  it("shares concurrent new-chat refreshes, then refreshes the next chat again", async () => {
    const pending = deferred();
    vi.mocked(refreshRuntimeConfigForNewChat).mockReturnValueOnce(
      pending.promise,
    );
    const first = useRuntimeConfigStore.getState().refreshForNewChat();
    const second = useRuntimeConfigStore.getState().refreshForNewChat();
    expect(first).toBe(second);
    expect(refreshRuntimeConfigForNewChat).toHaveBeenCalledOnce();
    expect(useRuntimeConfigStore.getState().config).toEqual(
      DEFAULT_RUNTIME_CONFIG,
    );
    pending.resolve(ready());
    await expect(first).resolves.toEqual(ready());
    expect(useRuntimeConfigStore.getState().config).toEqual(nextConfig);
    vi.mocked(refreshRuntimeConfigForNewChat).mockResolvedValueOnce(
      ready(DEFAULT_RUNTIME_CONFIG),
    );
    await useRuntimeConfigStore.getState().refreshForNewChat();
    expect(refreshRuntimeConfigForNewChat).toHaveBeenCalledTimes(2);
    expect(useRuntimeConfigStore.getState().config).toEqual(
      DEFAULT_RUNTIME_CONFIG,
    );
  });

  it("does not let a late startup load overwrite a new-chat refresh", async () => {
    const startup = deferred();
    vi.mocked(getRuntimeConfig).mockReturnValueOnce(startup.promise);
    const loading = useRuntimeConfigStore.getState().load();
    vi.mocked(refreshRuntimeConfigForNewChat).mockResolvedValueOnce(ready());
    await useRuntimeConfigStore.getState().refreshForNewChat();
    startup.resolve(ready(DEFAULT_RUNTIME_CONFIG));
    await expect(loading).resolves.toEqual(ready());
    expect(useRuntimeConfigStore.getState().config).toEqual(nextConfig);
  });

  it("does not let an old new-chat response overwrite a newer applied configuration", async () => {
    const pending = deferred();
    vi.mocked(refreshRuntimeConfigForNewChat).mockReturnValueOnce(
      pending.promise,
    );
    const refreshing = useRuntimeConfigStore.getState().refreshForNewChat();
    useRuntimeConfigStore.getState().setResult(ready());
    pending.resolve(ready(DEFAULT_RUNTIME_CONFIG));
    await expect(refreshing).resolves.toEqual(ready());
    expect(useRuntimeConfigStore.getState().config).toEqual(nextConfig);
  });

  it("retains the effective valid snapshot on transport or schema rejection", async () => {
    useRuntimeConfigStore.getState().setResult(ready());
    vi.mocked(refreshRuntimeConfigForNewChat).mockRejectedValueOnce(
      new Error("invalid response"),
    );
    await expect(
      useRuntimeConfigStore.getState().refreshForNewChat(),
    ).resolves.toEqual(ready());
    expect(useRuntimeConfigStore.getState().result).toEqual(ready());
    expect(useRuntimeConfigStore.getState().config).toEqual(nextConfig);
  });

  it("does not claim initial defaults are authoritative after transport failure", async () => {
    vi.mocked(refreshRuntimeConfigForNewChat).mockRejectedValueOnce(
      new Error("unavailable"),
    );
    await expect(
      useRuntimeConfigStore.getState().refreshForNewChat(),
    ).resolves.toMatchObject({ status: "unavailable" });
    expect(useRuntimeConfigStore.getState().result.status).toBe("unavailable");
    expect(useRuntimeConfigStore.getState().loaded).toBe(true);
  });
  it("does not preserve compiled-default fallback as an authoritative source", async () => {
    useRuntimeConfigStore.getState().setResult({
      status: "ready",
      source: "appDefault",
      config: DEFAULT_RUNTIME_CONFIG,
    });
    vi.mocked(refreshRuntimeConfigForNewChat).mockRejectedValueOnce(
      new Error("unavailable"),
    );
    await expect(
      useRuntimeConfigStore.getState().refreshForNewChat(),
    ).resolves.toMatchObject({ status: "unavailable" });
  });
});
