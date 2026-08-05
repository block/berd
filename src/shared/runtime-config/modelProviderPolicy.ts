import type { RuntimeConfig, RuntimeGooseConfig } from "./schema";

export interface GooseProviderSelection {
  providerId?: string | null;
  modelId?: string | null;
}

export interface ManagedGooseProviderSelection {
  providerId: string;
  modelId: string | undefined;
}

/**
 * Runtime model providers define provider policy and curated model metadata.
 * An empty list is the public/BYO contract: Berd does not own provider
 * selection. A non-empty list is a provider allowlist; its model inventory is
 * advisory and must not constrain models discovered from upstream providers.
 */
export function hasManagedGooseProviderPolicy(
  config: Pick<RuntimeConfig, "goose">,
): boolean {
  return config.goose.modelProviders.length > 0;
}

function defaultManagedProviderId(goose: RuntimeGooseConfig): string {
  const providerId = goose.defaultModelProviderId;
  if (!providerId) {
    throw new Error(
      "Managed Goose provider policy has no declared default provider.",
    );
  }
  return providerId;
}

/**
 * Resolve a Goose provider/model against runtime policy.
 *
 * - `null` means policy is unrestricted; the caller must preserve its values.
 * - Allowed providers and all of their upstream-discovered models stay selected.
 * - Disallowed/missing providers move to the runtime default provider.
 * - Existing model selections survive provider migration. A missing model uses
 *   the configured default, whose inventory entry is recommendation metadata.
 */
export function resolveManagedGooseProviderSelection(
  config: Pick<RuntimeConfig, "goose">,
  selection: GooseProviderSelection,
): ManagedGooseProviderSelection | null {
  const { goose } = config;
  if (goose.modelProviders.length === 0) {
    return null;
  }

  const configuredProviderId = goose.modelProviders.find(
    (provider) => provider.id === selection.providerId,
  )?.id;
  const providerId = configuredProviderId ?? defaultManagedProviderId(goose);
  const modelId = selection.modelId ?? goose.defaultModelId;

  return { providerId, modelId: modelId ?? undefined };
}

export function managedGooseSelectionChanged(
  current: GooseProviderSelection,
  resolved: ManagedGooseProviderSelection | null,
): boolean {
  if (!resolved) {
    return false;
  }
  return (
    current.providerId !== resolved.providerId ||
    current.modelId !== resolved.modelId
  );
}
