import { isSetupCatalogModelProvider } from "@/features/providers/api/catalog";
import { getBuildFeatureState } from "@/shared/profile/buildProfile";
import type { RuntimeConfig } from "@/shared/runtime-config/schema";
import type { ProviderCatalogEntry } from "@/shared/types/providers";

export function parseProviderAllowlist(
  runtimeConfig: RuntimeConfig | null | undefined,
): Set<string> | null {
  const providerIds =
    runtimeConfig?.goose.modelProviders
      .map((provider) => provider.id.trim())
      .filter(Boolean) ?? [];

  return providerIds.length > 0 ? new Set(providerIds) : null;
}

export function filterModelProvidersForRuntimeConfig(
  providers: ProviderCatalogEntry[],
  runtimeConfig: RuntimeConfig | null | undefined,
  options: { byoKeyProvidersEnabled?: boolean } = {},
): ProviderCatalogEntry[] {
  const allowlist = parseProviderAllowlist(runtimeConfig);
  if (!allowlist) {
    return providers;
  }

  const byoKeyProvidersEnabled =
    options.byoKeyProvidersEnabled ?? getBuildFeatureState().byoKeyProviders;

  // The allowlist constrains runtime/admin-managed model providers (defaults to
  // just `databricks_v2`). When the bring-your-own-key build feature is on, the
  // explicit openai/anthropic setup-catalog providers are an opt-in, user-driven
  // concept and aren't governed by the runtime allowlist, so let them through.
  // With the feature off, only allowlisted providers pass — the pre-feature
  // behavior.
  return providers.filter(
    (provider) =>
      allowlist.has(provider.id) ||
      (byoKeyProvidersEnabled &&
        (isSetupCatalogModelProvider(provider) ||
          provider.customProvider === true)),
  );
}

export function isProviderAllowedByAllowlist(
  providerId: string,
  allowlist: Set<string> | null,
): boolean {
  return !allowlist || allowlist.has(providerId);
}

export function hasAllowedModelProvider(
  providers: Pick<ProviderCatalogEntry, "id">[],
  allowlist: Set<string> | null,
): boolean {
  return providers.some((provider) =>
    isProviderAllowedByAllowlist(provider.id, allowlist),
  );
}
