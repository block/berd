import { useState, useEffect, useCallback } from "react";
import { checkAgentAuth } from "@/features/providers/api/agentSetup";
import { getProviderInventory } from "@/features/providers/api/inventory";
import { getAgentProvidersFromEntries } from "@/features/providers/providerCatalog";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useProviderInventoryStore } from "@/features/providers/stores/providerInventoryStore";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import type { ProviderInventoryEntryDto } from "@aaif/goose-sdk";

interface UseAgentProviderStatusReturn {
  readyAgentIds: Set<string>;
  loading: boolean;
  refresh: () => Promise<void>;
}

async function checkAgentProviderReady(
  provider: ProviderCatalogEntry,
  inventoryEntries: Map<string, ProviderInventoryEntryDto>,
): Promise<boolean> {
  if (provider.category !== "agent") {
    return false;
  }

  if (provider.setupMethod === "none") {
    return true;
  }

  const inventoryEntry = inventoryEntries.get(provider.id);
  const installed =
    inventoryEntry?.category === "agent" && inventoryEntry.configured;
  if (!installed) {
    return false;
  }

  try {
    if (provider.supportsAuthStatus) {
      return checkAgentAuth(provider.id);
    }

    if (provider.supportsAuth) {
      return (
        localStorage.getItem(`agent-provider-auth:${provider.id}`) === "true"
      );
    }

    return true;
  } catch {
    return false;
  }
}

const INITIAL_READY_AGENTS = new Set<string>(["goose"]);

function providersWithInventory(agents: ProviderCatalogEntry[]): string[] {
  return agents
    .filter((provider) => provider.setupMethod !== "none")
    .map((provider) => provider.id);
}

async function checkReadyAgentIds(
  agents: ProviderCatalogEntry[],
  inventoryEntries: Map<string, ProviderInventoryEntryDto>,
): Promise<Set<string>> {
  const readiness = await Promise.all(
    agents.map(async (provider) => ({
      id: provider.id,
      isReady: await checkAgentProviderReady(provider, inventoryEntries),
    })),
  );
  const readyIds = readiness
    .filter((provider) => provider.isReady)
    .map((provider) => provider.id);
  return new Set(["goose", ...readyIds]);
}

export function useAgentProviderStatus(): UseAgentProviderStatusReturn {
  const catalogEntries = useProviderCatalogStore((state) => state.entries);
  const inventoryEntries = useProviderInventoryStore((state) => state.entries);
  const mergeInventoryEntries = useProviderInventoryStore(
    (state) => state.mergeEntries,
  );
  const [readyAgentIds, setReadyAgentIds] =
    useState<Set<string>>(INITIAL_READY_AGENTS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const agents = getAgentProvidersFromEntries(catalogEntries);
    setLoading(true);
    checkReadyAgentIds(agents, inventoryEntries)
      .then((nextReadyAgentIds) => {
        if (!cancelled) {
          setReadyAgentIds(nextReadyAgentIds);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [catalogEntries, inventoryEntries]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const catalogEntries = useProviderCatalogStore.getState().entries;
      const agents = getAgentProvidersFromEntries(catalogEntries);
      const entries = await getProviderInventory(
        providersWithInventory(agents),
      );
      const nextInventoryEntries = new Map(
        useProviderInventoryStore.getState().entries,
      );
      for (const entry of entries) {
        nextInventoryEntries.set(entry.providerId, entry);
      }
      mergeInventoryEntries(entries);
      const nextReadyAgentIds = await checkReadyAgentIds(
        agents,
        nextInventoryEntries,
      );
      if (catalogEntries === useProviderCatalogStore.getState().entries) {
        setReadyAgentIds(nextReadyAgentIds);
      }
    } finally {
      setLoading(false);
    }
  }, [mergeInventoryEntries]);

  return {
    readyAgentIds,
    loading,
    refresh,
  };
}
