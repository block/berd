import { useState, useEffect, useCallback } from "react";
import {
  checkAgentAuth,
  checkAgentInstalled,
} from "@/features/providers/api/agentSetup";
import { getAgentProvidersFromEntries } from "@/features/providers/providerCatalog";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import type { ProviderCatalogEntry } from "@/shared/types/providers";

export type AgentProviderReadiness = "ready" | "not_installed" | "not_ready";

interface UseAgentProviderStatusReturn {
  readyAgentIds: Set<string>;
  agentReadiness: Map<string, AgentProviderReadiness>;
  loading: boolean;
  refresh: () => Promise<void>;
}

async function checkAgentProviderReadiness(
  provider: ProviderCatalogEntry,
): Promise<AgentProviderReadiness> {
  if (provider.category !== "agent") {
    return "not_ready";
  }

  if (provider.setupMethod === "none") {
    return "ready";
  }

  try {
    if (provider.binaryName) {
      const installed = await checkAgentInstalled(provider.id);
      if (!installed) {
        return "not_installed";
      }
    }

    if (provider.supportsAuthStatus) {
      return (await checkAgentAuth(provider.id)) ? "ready" : "not_ready";
    }

    if (provider.supportsAuth) {
      return localStorage.getItem(`agent-provider-auth:${provider.id}`) ===
        "true"
        ? "ready"
        : "not_ready";
    }

    return "ready";
  } catch {
    return provider.binaryName ? "not_installed" : "not_ready";
  }
}

const INITIAL_AGENT_READINESS = new Map<string, AgentProviderReadiness>([
  ["goose", "ready"],
]);
const INITIAL_READY_AGENTS = new Set<string>(["goose"]);

async function checkAgentReadiness(
  agents: ProviderCatalogEntry[],
): Promise<Map<string, AgentProviderReadiness>> {
  const readiness = await Promise.all(
    agents.map(async (provider) => ({
      id: provider.id,
      readiness: await checkAgentProviderReadiness(provider),
    })),
  );

  return new Map<string, AgentProviderReadiness>([
    ["goose", "ready"],
    ...readiness.map((provider) => [provider.id, provider.readiness] as const),
  ]);
}

function getReadyAgentIds(
  readiness: Map<string, AgentProviderReadiness>,
): Set<string> {
  return new Set(
    [...readiness.entries()]
      .filter(([, status]) => status === "ready")
      .map(([id]) => id),
  );
}

export function useAgentProviderStatus(): UseAgentProviderStatusReturn {
  const catalogEntries = useProviderCatalogStore((state) => state.entries);
  const [agentReadiness, setAgentReadiness] = useState<
    Map<string, AgentProviderReadiness>
  >(INITIAL_AGENT_READINESS);
  const [readyAgentIds, setReadyAgentIds] =
    useState<Set<string>>(INITIAL_READY_AGENTS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const agents = getAgentProvidersFromEntries(catalogEntries);
    setLoading(true);
    checkAgentReadiness(agents)
      .then((nextAgentReadiness) => {
        if (!cancelled) {
          setAgentReadiness(nextAgentReadiness);
          setReadyAgentIds(getReadyAgentIds(nextAgentReadiness));
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
  }, [catalogEntries]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const catalogEntries = useProviderCatalogStore.getState().entries;
      const agents = getAgentProvidersFromEntries(catalogEntries);
      const nextAgentReadiness = await checkAgentReadiness(agents);
      if (catalogEntries === useProviderCatalogStore.getState().entries) {
        setAgentReadiness(nextAgentReadiness);
        setReadyAgentIds(getReadyAgentIds(nextAgentReadiness));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    readyAgentIds,
    agentReadiness,
    loading,
    refresh,
  };
}
