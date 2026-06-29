import type {
  RuntimeConfig,
  RuntimeModelInventoryMode,
} from "@/shared/runtime-config/schema";
import { runtimeRefreshableModelProviderIds } from "./runtimeProviderConfig";
import { getAgentProviders } from "./providerCatalog";

export function getModelCacheRefreshProviderIds(
  runtimeConfig: RuntimeConfig | null | undefined,
  options: { defaultModelInventoryMode?: RuntimeModelInventoryMode } = {},
): string[] {
  const ids = new Set<string>();

  for (const providerId of runtimeRefreshableModelProviderIds(
    runtimeConfig,
    options.defaultModelInventoryMode,
  )) {
    ids.add(providerId);
  }

  for (const provider of getAgentProviders()) {
    if (provider.id === "goose" || provider.supportsModelList === false) {
      continue;
    }
    ids.add(provider.id);
  }

  return [...ids];
}
