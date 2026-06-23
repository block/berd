import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
  type RuntimeConfigLoadResult,
} from "@/shared/runtime-config/schema";
import {
  INITIAL_RUNTIME_CONFIG_RESULT,
  useRuntimeConfigStore,
} from "./runtimeConfigStore";

const mocks = vi.hoisted(() => ({
  clearFakeRuntimeConfig: vi.fn(),
  getRuntimeConfig: vi.fn(),
  refreshRuntimeConfig: vi.fn(),
  setFakeRuntimeConfig: vi.fn(),
}));

vi.mock("@/shared/api/runtimeConfig", () => ({
  clearFakeRuntimeConfig: mocks.clearFakeRuntimeConfig,
  getRuntimeConfig: mocks.getRuntimeConfig,
  refreshRuntimeConfig: mocks.refreshRuntimeConfig,
  setFakeRuntimeConfig: mocks.setFakeRuntimeConfig,
}));

const config = {
  schemaVersion: 1,
  providerAllowlist: ["openai"],
} satisfies RuntimeConfig;

const readyResult = {
  status: "ready",
  source: "fakeEndpoint",
  config,
} satisfies RuntimeConfigLoadResult;

const unavailableResult = {
  status: "unavailable",
  source: "fakeEndpoint",
  reason: "missing",
  message: "No fake response",
} satisfies RuntimeConfigLoadResult;

describe("runtime config store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRuntimeConfigStore.setState({
      loaded: false,
      result: INITIAL_RUNTIME_CONFIG_RESULT,
      config: DEFAULT_RUNTIME_CONFIG,
    });
  });

  it("loads and stores ready runtime config", async () => {
    mocks.getRuntimeConfig.mockResolvedValueOnce(readyResult);

    await expect(useRuntimeConfigStore.getState().load()).resolves.toEqual(
      readyResult,
    );

    expect(useRuntimeConfigStore.getState()).toMatchObject({
      loaded: true,
      result: readyResult,
      config,
    });
  });

  it("stores unavailable runtime config and keeps app defaults active", async () => {
    mocks.refreshRuntimeConfig.mockResolvedValueOnce(unavailableResult);

    await expect(useRuntimeConfigStore.getState().refresh()).resolves.toEqual(
      unavailableResult,
    );

    expect(useRuntimeConfigStore.getState()).toMatchObject({
      loaded: true,
      result: unavailableResult,
      config: DEFAULT_RUNTIME_CONFIG,
    });
  });

  it("persists fake runtime config through the api", async () => {
    mocks.setFakeRuntimeConfig.mockResolvedValueOnce(readyResult);

    await expect(
      useRuntimeConfigStore.getState().setFakeConfig(config),
    ).resolves.toEqual(readyResult);

    expect(mocks.setFakeRuntimeConfig).toHaveBeenCalledWith(config);
    expect(useRuntimeConfigStore.getState().config).toEqual(config);
  });

  it("clears fake runtime config through the api", async () => {
    useRuntimeConfigStore.setState({
      loaded: true,
      result: readyResult,
      config,
    });
    mocks.clearFakeRuntimeConfig.mockResolvedValueOnce(unavailableResult);

    await expect(
      useRuntimeConfigStore.getState().clearFakeConfig(),
    ).resolves.toEqual(unavailableResult);

    expect(mocks.clearFakeRuntimeConfig).toHaveBeenCalledWith();
    expect(useRuntimeConfigStore.getState().config).toEqual(
      DEFAULT_RUNTIME_CONFIG,
    );
  });
});
