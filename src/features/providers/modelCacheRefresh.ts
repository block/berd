import type { RuntimeConfig } from "@/shared/runtime-config/schema";
import { filterModelProvidersForRuntimeConfig } from "./runtimeProviderConstraints";
import { getAgentProviders, getModelProviders } from "./providerCatalog";

export function getModelCacheRefreshProviderIds(
  runtimeConfig: RuntimeConfig | null | undefined,
): string[] {
  const ids = new Set<string>();

  for (const provider of filterModelProvidersForRuntimeConfig(
    getModelProviders(),
    runtimeConfig,
  )) {
    ids.add(provider.id);
  }

  for (const provider of getAgentProviders()) {
    if (provider.id === "goose" || provider.supportsModelList === false) {
      continue;
    }
    ids.add(provider.id);
  }

  return [...ids];
}
