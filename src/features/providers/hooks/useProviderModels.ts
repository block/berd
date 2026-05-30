import { useCallback, useMemo } from "react";
import { useDistroStore } from "@/features/settings/stores/distroStore";
import type { ModelOption } from "@/features/chat/types";
import { filterModelProvidersForDistro } from "../distroProviderConstraints";
import { getModelProviders } from "../providerCatalog";
import { getModelCacheRefreshProviderIds } from "../modelCacheRefresh";
import { getProviderModelSelectionHint } from "../modelSelectionHints";
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
  const distro = useDistroStore((state) => state.manifest);

  const configuredModelProviderIds = useMemo(
    () =>
      filterModelProvidersForDistro(getModelProviders(), distro).map(
        (p) => p.id,
      ),
    [distro],
  );
  const modelCacheRefreshProviderIds = useMemo(
    () => getModelCacheRefreshProviderIds(distro),
    [distro],
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
