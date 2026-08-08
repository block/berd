import type { RuntimeConfig, RuntimeGooseConfig } from "./schema";
import { normalizeConcreteModelId } from "@/shared/lib/modelIdentity";
import { getClient } from "@/shared/api/acpConnection";

export interface GooseProviderSelection {
  providerId?: string | null;
  modelId?: string | null;
}

export interface ManagedGooseProviderSelection {
  providerId: string;
  modelId: string | undefined;
}

export interface ManagedGooseProviderResolutionContext {
  /** Raw, refreshed model ids for the resolved target provider. */
  targetModelIds?: ReadonlySet<string>;
  /** True only when targetModelIds came from a successful provider refresh. */
  targetInventoryValidated?: boolean;
}

const DATABRICKS_V2_PROVIDER_ID = "databricks_v2";

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
  context: ManagedGooseProviderResolutionContext = {},
): ManagedGooseProviderSelection | null {
  const { goose } = config;
  if (goose.modelProviders.length === 0) {
    return null;
  }

  const configuredProviderId = goose.modelProviders.find(
    (provider) => provider.id === selection.providerId,
  )?.id;
  const providerId = configuredProviderId ?? defaultManagedProviderId(goose);
  let modelId =
    normalizeConcreteModelId(selection.modelId) ??
    normalizeConcreteModelId(goose.defaultModelId);

  if (
    providerId === DATABRICKS_V2_PROVIDER_ID &&
    modelId &&
    context.targetInventoryValidated === true &&
    !context.targetModelIds?.has(modelId)
  ) {
    modelId = goose.defaultModelId;
  }

  return { providerId, modelId: modelId ?? undefined };
}

/**
 * Resolve a managed provider migration only after the target provider proves
 * support for the selected (or fallback) model. Runtime config metadata is
 * advisory, so it is never evidence for this decision.
 */
export async function resolveValidatedManagedGooseProviderSelection(
  config: Pick<RuntimeConfig, "goose">,
  selection: GooseProviderSelection,
): Promise<ManagedGooseProviderSelection | null> {
  const resolved = resolveManagedGooseProviderSelection(config, selection);
  if (!resolved || resolved.providerId === selection.providerId) {
    return resolved;
  }

  let supportedModelIds: ReadonlySet<string>;
  try {
    const client = await getClient();
    const response =
      await client.goose.GooseUnstableProvidersSupportedModelsList({
        providerId: resolved.providerId,
      });
    supportedModelIds = new Set(response.models as string[]);
  } catch (error) {
    throw new Error(
      `Cannot verify models for migrated provider ${resolved.providerId}; provider selection was not changed.`,
      { cause: error },
    );
  }

  if (resolved.modelId && supportedModelIds.has(resolved.modelId)) {
    return resolved;
  }
  const fallbackModelId = normalizeConcreteModelId(config.goose.defaultModelId);
  if (fallbackModelId && supportedModelIds.has(fallbackModelId)) {
    return { providerId: resolved.providerId, modelId: fallbackModelId };
  }
  const provenInventoryFallback = [...supportedModelIds].sort()[0];
  if (provenInventoryFallback) {
    return {
      providerId: resolved.providerId,
      modelId: provenInventoryFallback,
    };
  }
  throw new Error(
    `No supported model is available for migrated provider ${resolved.providerId}; provider selection was not changed.`,
  );
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
