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
  const { readyAgentIds, loading: readyAgentsLoading } =
    useAgentProviderStatus();

  const providers = allProviders;

  const selectedProvider = useMemo(() => {
    const selectedAgentId = resolveAgentProviderCatalogIdStrictFromEntries(
      catalogEntries,
      storedSelectedProvider,
    );
    if (!selectedAgentId) {
      // Stored id isn't a known agent provider. The live provider list is
      // sourced from the curated catalog, so an unresolved id is stale/unknown
      // and can't be served — fall back to goose instead of leaking it to the
      // backend ("Provider not set"). Keep the stored value until the catalog
      // is loaded so we don't downgrade prematurely.
      return catalogLoaded ? "goose" : storedSelectedProvider;
    }
    if (!readyAgentIds.has(selectedAgentId)) {
      return "goose";
    }
    return storedSelectedProvider;
  }, [catalogEntries, catalogLoaded, readyAgentIds, storedSelectedProvider]);

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
