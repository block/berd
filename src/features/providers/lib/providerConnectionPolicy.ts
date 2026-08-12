import type { ProviderSecretDto } from "@aaif/goose-sdk";
import type {
  ProviderCatalogEntry,
  ProviderFieldValue,
} from "@/shared/types/providers";

/**
 * Provider ids with a stored Goose credential: an API key in the secret
 * store or a cached OAuth token. This is the authoritative "Active"
 * evidence — Goose only stores these after a deliberate user action
 * (saving a key or completing a sign-in flow).
 */
export function getCredentialedProviderIds(
  secrets: ProviderSecretDto[],
): Set<string> {
  const ids = new Set<string>();
  for (const secret of secrets) {
    if (secret.hasSecret && secret.status !== "expired") {
      ids.add(secret.provider);
    }
  }
  return ids;
}

/**
 * Whether a catalog entry matches a credentialed provider id, including
 * backend-provided aliases (e.g. the shared Databricks OAuth cache is
 * reported under one alias while the catalog entry uses another).
 */
export function isCredentialedProvider(
  provider: Pick<ProviderCatalogEntry, "id" | "aliases">,
  credentialedIds: ReadonlySet<string>,
): boolean {
  if (credentialedIds.has(provider.id)) return true;
  return (provider.aliases ?? []).some((alias) => credentialedIds.has(alias));
}

export type ProviderConnectionEvidence =
  | "credential"
  | "managed_endpoint"
  | "custom"
  | "saved_settings"
  | "none";

export interface ProviderConnectionSnapshot {
  configuredIds: ReadonlySet<string>;
  credentialedIds: ReadonlySet<string>;
  runtimeManagedIds: ReadonlySet<string>;
  configuredBySavedValueIds?: ReadonlySet<string>;
}

/**
 * Classify the strongest deliberate setup evidence for a model provider.
 * This is the shared policy boundary for settings presentation and default
 * recovery. Backend "configured" status is required for managed, custom, and
 * saved-setting evidence; a stored credential remains authoritative by itself.
 */
export function getProviderConnectionEvidence(
  provider: Pick<ProviderCatalogEntry, "id" | "aliases" | "customProvider">,
  snapshot: ProviderConnectionSnapshot,
): ProviderConnectionEvidence {
  if (isCredentialedProvider(provider, snapshot.credentialedIds)) {
    return "credential";
  }
  if (!snapshot.configuredIds.has(provider.id)) {
    return "none";
  }
  if (snapshot.runtimeManagedIds.has(provider.id)) {
    return "managed_endpoint";
  }
  if (provider.customProvider === true) {
    return "custom";
  }
  if (snapshot.configuredBySavedValueIds?.has(provider.id)) {
    return "saved_settings";
  }
  return "none";
}

/**
 * Whether the provider has a meaningful saved non-secret setting: set,
 * readable, and different from the schema default. Untouched defaults and
 * ambient-only readiness never count, and secret values seen through generic
 * config reads are ignored entirely. This is evidence of user configuration,
 * not proof that the provider is reachable.
 */
export function hasMeaningfulSavedSettings(
  provider: ProviderCatalogEntry,
  values: ProviderFieldValue[],
): boolean {
  const fieldsByKey = new Map(
    (provider.fields ?? []).map((field) => [field.key, field]),
  );
  return values.some((value) => {
    if (!value.isSet || value.isSecret) return false;
    if (value.value == null) return false;
    const defaultValue = fieldsByKey.get(value.key)?.defaultValue ?? null;
    return defaultValue == null || value.value !== defaultValue;
  });
}
