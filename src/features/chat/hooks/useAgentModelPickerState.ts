import { useCallback, useMemo, useRef } from "react";
import type { AcpProvider } from "@/shared/api/acp";
import { useProviderModels } from "@/features/providers/hooks/useProviderModels";
import { useAgentProviderStatus } from "@/features/providers/hooks/useAgentProviderStatus";
import {
  getCatalogEntryFromEntries,
  resolveAgentProviderCatalogIdStrictFromEntries,
} from "@/features/providers/providerCatalog";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { resolveSelectedAgentId } from "../lib/agentProviderResolution";
import type { ModelOption } from "../types";

interface UseAgentModelPickerStateOptions {
  providers: AcpProvider[];
  selectedProvider?: string;
  onProviderSelected: (providerId: string) => void;
  onModelSelected?: (model: ModelOption) => void;
}

const EMPTY_MODELS: ModelOption[] = [];

export function useAgentModelPickerState({
  providers,
  selectedProvider,
  onProviderSelected,
  onModelSelected,
}: UseAgentModelPickerStateOptions) {
  const catalogEntries = useProviderCatalogStore((state) => state.entries);
  const catalogLoaded = useProviderCatalogStore((state) => state.loaded);
  const {
    configuredModelProviderIds,
    modelCacheRefreshProviderIds,
    getModelsForAgent,
    refreshAllModelProviders,
    isRefreshingProvider,
    getError,
  } = useProviderModels();
  const { readyAgentIds, refresh: refreshAgentProviderStatus } =
    useAgentProviderStatus();

  const selectedAgentId = useMemo(
    () =>
      resolveSelectedAgentId({
        catalogEntries,
        catalogLoaded,
        selectedProvider,
      }),
    [catalogEntries, catalogLoaded, selectedProvider],
  );

  const pickerAgents = useMemo(() => {
    const visible = new Map<string, { id: string; label: string }>();

    visible.set("goose", {
      id: "goose",
      label:
        getCatalogEntryFromEntries(catalogEntries, "goose")?.displayName ??
        "Goose",
    });

    for (const provider of providers) {
      const agentId =
        resolveAgentProviderCatalogIdStrictFromEntries(
          catalogEntries,
          provider.id,
        ) ?? (!catalogLoaded ? provider.id : null);
      if (!agentId || agentId === "goose" || !readyAgentIds.has(agentId)) {
        continue;
      }

      visible.set(agentId, {
        id: agentId,
        label:
          getCatalogEntryFromEntries(catalogEntries, agentId)?.displayName ??
          provider.label,
      });
    }

    if (!visible.has(selectedAgentId) && readyAgentIds.has(selectedAgentId)) {
      visible.set(selectedAgentId, {
        id: selectedAgentId,
        label:
          getCatalogEntryFromEntries(catalogEntries, selectedAgentId)
            ?.displayName ?? selectedAgentId,
      });
    }

    return [...visible.values()];
  }, [
    catalogEntries,
    catalogLoaded,
    providers,
    readyAgentIds,
    selectedAgentId,
  ]);

  const availableModels = useMemo(
    () => getModelsForAgent(selectedAgentId) ?? EMPTY_MODELS,
    [getModelsForAgent, selectedAgentId],
  );

  const providerIdsForSelectedAgent =
    selectedAgentId === "goose"
      ? configuredModelProviderIds
      : [selectedAgentId];

  const modelsLoading = useMemo(() => {
    if (availableModels.length > 0) {
      return false;
    }

    return providerIdsForSelectedAgent.some(isRefreshingProvider);
  }, [
    availableModels.length,
    isRefreshingProvider,
    providerIdsForSelectedAgent,
  ]);

  const modelStatusMessage = useMemo(() => {
    if (availableModels.length > 0) {
      return null;
    }

    return (
      providerIdsForSelectedAgent.map(getError).find((message) => message) ??
      null
    );
  }, [availableModels.length, getError, providerIdsForSelectedAgent]);

  const handleProviderChange = useCallback(
    (providerId: string) => {
      if (providerId === (selectedProvider ?? "goose")) {
        return;
      }

      onProviderSelected(providerId);
    },
    [onProviderSelected, selectedProvider],
  );

  const handleModelChange = useCallback(
    (modelId: string, selectedModelOverride?: ModelOption) => {
      const selectedModel =
        selectedModelOverride ??
        availableModels.find((model) => model.id === modelId);
      onModelSelected?.({
        id: modelId,
        name: selectedModel?.name ?? modelId,
        displayName: selectedModel?.displayName ?? modelId,
        provider: selectedModel?.provider,
        providerId: selectedModel?.providerId,
        providerName: selectedModel?.providerName,
        contextLimit: selectedModel?.contextLimit,
        recommended: selectedModel?.recommended,
      });
    },
    [availableModels, onModelSelected],
  );

  const refreshingRef = useRef(false);
  const handlePickerOpen = useCallback(() => {
    if (refreshingRef.current) {
      return;
    }
    refreshingRef.current = true;
    Promise.all([
      refreshAgentProviderStatus(),
      refreshAllModelProviders(modelCacheRefreshProviderIds),
    ])
      .catch((err) => console.error("Failed to refresh picker data:", err))
      .finally(() => {
        refreshingRef.current = false;
      });
  }, [
    modelCacheRefreshProviderIds,
    refreshAgentProviderStatus,
    refreshAllModelProviders,
  ]);

  return {
    selectedAgentId,
    pickerAgents,
    availableModels,
    modelsLoading,
    modelStatusMessage,
    handleProviderChange,
    handleModelChange,
    handlePickerOpen,
  };
}
