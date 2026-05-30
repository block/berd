import type { DistroBundleInfo } from "@/shared/types/distro";
import { filterModelProvidersForDistro } from "./distroProviderConstraints";
import { getAgentProviders, getModelProviders } from "./providerCatalog";

export function getModelCacheRefreshProviderIds(
  distro: DistroBundleInfo | null | undefined,
): string[] {
  const ids = new Set<string>();

  for (const provider of filterModelProvidersForDistro(
    getModelProviders(),
    distro,
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
