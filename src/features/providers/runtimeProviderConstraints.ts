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
): ProviderCatalogEntry[] {
  const allowlist = parseProviderAllowlist(runtimeConfig);
  if (!allowlist) {
    return providers;
  }

  return providers.filter((provider) => allowlist.has(provider.id));
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
