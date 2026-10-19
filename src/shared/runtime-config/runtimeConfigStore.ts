import { create } from "zustand";
import {
  clearFakeRuntimeConfig,
  getRuntimeConfig,
  refreshRuntimeConfig,
  refreshRuntimeConfigForNewChat,
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
  refreshForNewChat: () => Promise<RuntimeConfigLoadResult>;
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

export const useRuntimeConfigStore = create<RuntimeConfigState>((set, get) => {
  let generation = 0;
  let newChatRefresh: Promise<RuntimeConfigLoadResult> | undefined;

  const applyResult = (result: RuntimeConfigLoadResult) => {
    set(resultState(result));
    return result;
  };
  const request = async (
    load: () => Promise<RuntimeConfigLoadResult>,
  ): Promise<RuntimeConfigLoadResult> => {
    const requestGeneration = ++generation;
    const result = await load();
    return requestGeneration === generation
      ? applyResult(result)
      : get().result;
  };

  return {
    loaded: false,
    result: INITIAL_RUNTIME_CONFIG_RESULT,
    config: DEFAULT_RUNTIME_CONFIG,

    load: () => request(getRuntimeConfig),
    refresh: () => request(refreshRuntimeConfig),
    refreshForNewChat: () => {
      // Concurrent creation gestures share one source refresh. A later new
      // chat always evaluates the source again; this is not a time-based cache.
      if (newChatRefresh) return newChatRefresh;
      const pending = request(async () => {
        try {
          return await refreshRuntimeConfigForNewChat();
        } catch {
          // Transport/schema failures must not replace a valid native snapshot
          // with defaults or erase saved Auto intent. Native owns source timeout
          // and last-good fallback for a successfully delivered command.
          const current = get();
          if (
            current.loaded &&
            current.result.status === "ready" &&
            current.result.source !== "appDefault"
          ) {
            return current.result;
          }
          return {
            status: "unavailable" as const,
            source: current.result.source,
            reason: "endpointUnavailable" as const,
            message: "Runtime configuration refresh unavailable",
          };
        }
      });
      newChatRefresh = pending;
      void pending.finally(() => {
        if (newChatRefresh === pending) newChatRefresh = undefined;
      });
      return pending;
    },
    setFakeConfig: (config) => request(() => setFakeRuntimeConfig(config)),
    clearFakeConfig: () => request(clearFakeRuntimeConfig),
    setResult: (result) => {
      ++generation;
      set(resultState(result));
    },
  };
});
