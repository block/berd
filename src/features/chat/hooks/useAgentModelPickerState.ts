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
import type { AgentPickerOption, ModelOption } from "../types";

interface UseAgentModelPickerStateOptions {
  providers: AcpProvider[];
  selectedProvider?: string;
  onProviderSelected: (providerId: string, models: ModelOption[]) => void;
  onModelSelected?: (model: ModelOption) => void;
}

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
    isModelInventoryAuthoritative: isProviderModelInventoryAuthoritative,
    refreshAllModelProviders,
    isRefreshingProvider,
    getError,
  } = useProviderModels();
  const {
    readyAgentIds,
    agentReadiness,
    refresh: refreshAgentProviderStatus,
  } = useAgentProviderStatus();

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
    const visible = new Map<string, AgentPickerOption>();
    const gooseReadiness = agentReadiness.get("goose") ?? "not_ready";

    visible.set("goose", {
      id: "goose",
      label:
        getCatalogEntryFromEntries(catalogEntries, "goose")?.displayName ??
        "Goose",
      readiness: gooseReadiness,
      ...(gooseReadiness === "ready" ? {} : { setupAction: "connect" }),
    });

    for (const provider of providers) {
      const agentId =
        resolveAgentProviderCatalogIdStrictFromEntries(
          catalogEntries,
          provider.id,
        ) ?? (!catalogLoaded ? provider.id : null);
      if (!agentId || agentId === "goose") {
        continue;
      }

      const catalogEntry = getCatalogEntryFromEntries(catalogEntries, agentId);
      const readiness = agentReadiness.get(agentId) ?? "not_ready";
      const setupAction =
        readiness === "ready"
          ? undefined
          : readiness === "not_installed" && catalogEntry?.supportsInstall
            ? "install"
            : "connect";

      visible.set(agentId, {
        id: agentId,
        label: catalogEntry?.displayName ?? provider.label,
        readiness,
        setupAction,
      });
    }

    if (!visible.has(selectedAgentId) && readyAgentIds.has(selectedAgentId)) {
      visible.set(selectedAgentId, {
        id: selectedAgentId,
        label:
          getCatalogEntryFromEntries(catalogEntries, selectedAgentId)
            ?.displayName ?? selectedAgentId,
        readiness: "ready",
      });
    }

    return [...visible.values()];
  }, [
    agentReadiness,
    catalogEntries,
    catalogLoaded,
    providers,
    readyAgentIds,
    selectedAgentId,
  ]);

  const availableModels = useMemo(
    () => getModelsForAgent(selectedAgentId),
    [getModelsForAgent, selectedAgentId],
  );

  const providerIdsForSelectedAgent = useMemo(
    () =>
      selectedAgentId === "goose"
        ? configuredModelProviderIds
        : [selectedAgentId],
    [configuredModelProviderIds, selectedAgentId],
  );

  const isModelInventoryAuthoritative = useCallback(
    (providerId?: string) => {
      const providerIds = providerId
        ? [providerId]
        : providerIdsForSelectedAgent;
      return (
        providerIds.length > 0 &&
        providerIds.every(isProviderModelInventoryAuthoritative)
      );
    },
    [isProviderModelInventoryAuthoritative, providerIdsForSelectedAgent],
  );

  const isRefreshingModels =
    providerIdsForSelectedAgent.some(isRefreshingProvider);
  const modelsLoading =
    isRefreshingModels &&
    (availableModels.length === 0 || !isModelInventoryAuthoritative());

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

      if (!readyAgentIds.has(providerId)) {
        return;
      }

      onProviderSelected(providerId, getModelsForAgent(providerId));
    },
    [getModelsForAgent, onProviderSelected, readyAgentIds, selectedProvider],
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
    getModelsForAgent,
    isModelInventoryAuthoritative,
    modelsLoading,
    modelStatusMessage,
    handleProviderChange,
    handleModelChange,
    handlePickerOpen,
  };
}
