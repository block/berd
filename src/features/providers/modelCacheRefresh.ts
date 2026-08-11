import type {
  RuntimeConfig,
  RuntimeModelInventoryMode,
} from "@/shared/runtime-config/schema";
import { getBuildFeatureState } from "@/shared/profile/buildProfile";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import { isSetupCatalogModelProvider } from "./api/catalog";
import {
  getAgentProviders,
  getAgentProvidersFromEntries,
  getModelProviders,
  getModelProvidersFromEntries,
} from "./providerCatalog";
import {
  runtimeManagedModelProviderIds,
  runtimeRefreshableModelProviderIds,
} from "./runtimeProviderConfig";

export function getModelCacheRefreshProviderIds(
  runtimeConfig: RuntimeConfig | null | undefined,
  options: {
    defaultModelInventoryMode?: RuntimeModelInventoryMode;
    byoKeyProvidersEnabled?: boolean;
    catalogEntries?: ProviderCatalogEntry[];
    configuredProviderIds?: ReadonlySet<string> | readonly string[];
  } = {},
): string[] {
  const {
    defaultModelInventoryMode,
    byoKeyProvidersEnabled = getBuildFeatureState().byoKeyProviders,
    catalogEntries,
    configuredProviderIds,
  } = options;
  const ids = new Set<string>();
  const configuredIds = configuredProviderIds
    ? new Set(configuredProviderIds)
    : null;

  for (const providerId of [
    ...runtimeManagedModelProviderIds(runtimeConfig, defaultModelInventoryMode),
    ...runtimeRefreshableModelProviderIds(
      runtimeConfig,
      defaultModelInventoryMode,
    ),
  ]) {
    ids.add(providerId);
  }

  const modelProviders = catalogEntries
    ? getModelProvidersFromEntries(catalogEntries)
    : getModelProviders();
  if (byoKeyProvidersEnabled) {
    for (const provider of modelProviders) {
      if (
        (configuredIds === null || configuredIds.has(provider.id)) &&
        (isSetupCatalogModelProvider(provider) ||
          provider.customProvider === true)
      ) {
        ids.add(provider.id);
      }
    }
  }

  const agentProviders = catalogEntries
    ? getAgentProvidersFromEntries(catalogEntries)
    : getAgentProviders();
  for (const provider of agentProviders) {
    if (provider.id === "goose" || provider.supportsModelList === false) {
      continue;
    }
    ids.add(provider.id);
  }

  return [...ids];
}
