import { useCallback, useMemo } from "react";
import { useAgentStore } from "../stores/agentStore";
import { selectSelectedProvider } from "../stores/agentSelectors";
import { useAgentProviderStatus } from "@/features/providers/hooks/useAgentProviderStatus";
import { resolveAgentProviderCatalogIdStrictFromEntries } from "@/features/providers/providerCatalog";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";

export function useProviderSelection() {
  const allProviders = useAgentStore((s) => s.providers);
  const providersLoading = useAgentStore((s) => s.providersLoading);
  const storedSelectedProvider = useAgentStore(selectSelectedProvider);
  const storeSetSelectedProvider = useAgentStore((s) => s.setSelectedProvider);
  const catalogEntries = useProviderCatalogStore((state) => state.entries);
  const catalogLoaded = useProviderCatalogStore((state) => state.loaded);
  const { loading: readyAgentsLoading } = useAgentProviderStatus();

  const providers = allProviders;

  const selectedProvider = useMemo(() => {
    const selectedAgentId = resolveAgentProviderCatalogIdStrictFromEntries(
      catalogEntries,
      storedSelectedProvider,
    );
    // Selection is preference, not readiness. Session creation resolves stale
    // or unavailable implicit preferences through the shared target resolver.
    return (
      selectedAgentId ?? (catalogLoaded ? "goose" : storedSelectedProvider)
    );
  }, [catalogEntries, catalogLoaded, storedSelectedProvider]);

  const setSelectedProvider = useCallback(
    (providerId: string) => {
      storeSetSelectedProvider(providerId, true);
    },
    [storeSetSelectedProvider],
  );

  const setSelectedProviderWithoutPersist = useCallback(
    (providerId: string) => {
      storeSetSelectedProvider(providerId, false);
    },
    [storeSetSelectedProvider],
  );

  return {
    providers,
    providersLoading: providersLoading || readyAgentsLoading,
    selectedProvider,
    setSelectedProvider,
    setSelectedProviderWithoutPersist,
  };
}
