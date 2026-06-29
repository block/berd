import { useCallback, useMemo } from "react";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import type { ModelOption } from "@/features/chat/types";
import { filterModelProvidersForRuntimeConfig } from "../runtimeProviderConstraints";
import { getModelProviders } from "../providerCatalog";
import { getModelCacheRefreshProviderIds } from "../modelCacheRefresh";
import { getProviderModelSelectionHint } from "../modelSelectionHints";
import { defaultModelInventoryModeForLoadResult } from "../runtimeProviderConfig";
import { useProviderModelCacheStore } from "../stores/providerModelCacheStore";

const EMPTY_MODELS: ModelOption[] = [];

export function useProviderModels() {
  const providers = useProviderModelCacheStore((state) => state.providers);
  const refreshingProviderIds = useProviderModelCacheStore(
    (state) => state.refreshingProviderIds,
  );
  const refreshProviderModels = useProviderModelCacheStore(
    (state) => state.refreshProviderModels,
  );
  const refreshAllModelProviders = useProviderModelCacheStore(
    (state) => state.refreshAllModelProviders,
  );
  const runtimeConfig = useRuntimeConfigStore((state) => state.config);
  const runtimeConfigResult = useRuntimeConfigStore((state) => state.result);

  const configuredModelProviderIds = useMemo(
    () =>
      filterModelProvidersForRuntimeConfig(
        getModelProviders(),
        runtimeConfig,
      ).map((p) => p.id),
    [runtimeConfig],
  );
  const modelCacheRefreshProviderIds = useMemo(
    () =>
      getModelCacheRefreshProviderIds(runtimeConfig, {
        defaultModelInventoryMode:
          defaultModelInventoryModeForLoadResult(runtimeConfigResult),
      }),
    [runtimeConfig, runtimeConfigResult],
  );

  const getModelsForProvider = useCallback(
    (providerId: string) => providers.get(providerId)?.models ?? EMPTY_MODELS,
    [providers],
  );

  const getModelsForAgent = useCallback(
    (agentId: string) => {
      if (agentId !== "goose") {
        return getModelsForProvider(agentId);
      }

      return configuredModelProviderIds.flatMap(
        (providerId) => providers.get(providerId)?.models ?? [],
      );
    },
    [configuredModelProviderIds, getModelsForProvider, providers],
  );

  const isRefreshingProvider = useCallback(
    (providerId: string) => refreshingProviderIds.has(providerId),
    [refreshingProviderIds],
  );

  const getError = useCallback(
    (providerId: string) =>
      getProviderModelSelectionHint(providerId) ??
      providers.get(providerId)?.error ??
      null,
    [providers],
  );

  return {
    configuredModelProviderIds,
    modelCacheRefreshProviderIds,
    getModelsForAgent,
    getModelsForProvider,
    refreshProviderModels,
    refreshAllModelProviders,
    isRefreshingProvider,
    getError,
  };
}
