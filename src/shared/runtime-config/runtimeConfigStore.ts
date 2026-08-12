import { create } from "zustand";
import {
  clearFakeRuntimeConfig,
  getRuntimeConfig,
  refreshRuntimeConfig,
  setFakeRuntimeConfig,
} from "@/shared/api/runtimeConfig";
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
  type RuntimeConfigLoadResult,
} from "@/shared/runtime-config/schema";

export const INITIAL_RUNTIME_CONFIG_RESULT: RuntimeConfigLoadResult = {
  status: "ready",
  source: "appDefault",
  config: DEFAULT_RUNTIME_CONFIG,
};

interface RuntimeConfigState {
  loaded: boolean;
  result: RuntimeConfigLoadResult;
  config: RuntimeConfig;
  load: () => Promise<RuntimeConfigLoadResult>;
  refresh: () => Promise<RuntimeConfigLoadResult>;
  setFakeConfig: (config: RuntimeConfig) => Promise<RuntimeConfigLoadResult>;
  clearFakeConfig: () => Promise<RuntimeConfigLoadResult>;
  setResult: (result: RuntimeConfigLoadResult) => void;
}

function configForResult(result: RuntimeConfigLoadResult): RuntimeConfig {
  return result.status === "ready" ? result.config : DEFAULT_RUNTIME_CONFIG;
}

function resultState(result: RuntimeConfigLoadResult) {
  return {
    loaded: true,
    result,
    config: configForResult(result),
  };
}

export const useRuntimeConfigStore = create<RuntimeConfigState>((set) => {
  const applyResult = (result: RuntimeConfigLoadResult) => {
    set(resultState(result));
    return result;
  };

  return {
    loaded: false,
    result: INITIAL_RUNTIME_CONFIG_RESULT,
    config: DEFAULT_RUNTIME_CONFIG,

    load: async () => applyResult(await getRuntimeConfig()),
    refresh: async () => applyResult(await refreshRuntimeConfig()),
    setFakeConfig: async (config) =>
      applyResult(await setFakeRuntimeConfig(config)),
    clearFakeConfig: async () => applyResult(await clearFakeRuntimeConfig()),
    setResult: (result) => set(resultState(result)),
  };
});
