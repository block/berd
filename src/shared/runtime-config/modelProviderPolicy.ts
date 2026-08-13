import type { RuntimeConfig, RuntimeGooseConfig } from "./schema";
import { normalizeConcreteModelId } from "@/shared/lib/modelIdentity";
import {
  getClient,
  invalidateClientConnection,
} from "@/shared/api/acpConnection";
import { providerModelInventoryGeneration } from "./providerModelInventoryInvalidation";

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

const INVENTORY_PROOF_TIMEOUT_MS = 60_000;

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
 * - Existing concrete model selections survive while proof is unavailable.
 * - A configured default is synthesized only from successful inventory proof.
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
  const providerWasMigrated = configuredProviderId === undefined;
  const selectedModelId = normalizeConcreteModelId(selection.modelId);
  const defaultModelId = normalizeConcreteModelId(goose.defaultModelId);
  if (context.targetInventoryValidated === true) {
    const provenModelIds = context.targetModelIds ?? new Set<string>();
    const needsModelRepair = providerWasMigrated || selection.modelId != null;
    const modelId =
      (selectedModelId && provenModelIds.has(selectedModelId)
        ? selectedModelId
        : undefined) ??
      // A default is a synthesized fallback. Do not turn same-provider,
      // provider-only intent into a concrete selection merely because live
      // inventory happened to be available. It may repair an existing concrete
      // selection (including a legacy sentinel) or a provider migration.
      (needsModelRepair && defaultModelId && provenModelIds.has(defaultModelId)
        ? defaultModelId
        : undefined);
    return { providerId, modelId };
  }

  return { providerId, modelId: selectedModelId };
}

/**
 * Read a provider's live model inventory as authoritative evidence for managed
 * configuration decisions. Both ACP acquisition and the inventory RPC share
 * one deadline; a timeout invalidates the connection so a later proof starts
 * from fresh state. Results from an invalidated inventory generation are never
 * accepted.
 */
export async function readBoundedProvenModelInventory(
  providerId: string,
): Promise<ReadonlySet<string>> {
  const generationAtStart = providerModelInventoryGeneration(providerId);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let didTimeOut = false;
  try {
    const response = await Promise.race([
      getClient().then((client) =>
        client.goose.GooseUnstableProvidersSupportedModelsList({ providerId }),
      ),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          didTimeOut = true;
          reject(
            new Error(`Timed out proving models for provider ${providerId}.`),
          );
        }, INVENTORY_PROOF_TIMEOUT_MS);
      }),
    ]);
    if (generationAtStart !== providerModelInventoryGeneration(providerId)) {
      throw new Error(
        `Model inventory changed while proving provider ${providerId}.`,
      );
    }
    return new Set(response.models as string[]);
  } catch (error) {
    if (didTimeOut) {
      await invalidateClientConnection().catch((invalidationError) => {
        console.error(
          "Failed to invalidate timed-out ACP connection:",
          invalidationError,
        );
      });
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export async function resolveValidatedManagedGooseProviderSelection(
  config: Pick<RuntimeConfig, "goose">,
  selection: GooseProviderSelection,
): Promise<ManagedGooseProviderSelection | null> {
  const resolved = resolveManagedGooseProviderSelection(config, selection);
  if (!resolved) return null;

  let supportedModelIds: ReadonlySet<string>;
  try {
    supportedModelIds = await readBoundedProvenModelInventory(
      resolved.providerId,
    );
  } catch (error) {
    if (resolved.providerId === selection.providerId) return resolved;
    throw new Error(
      `Cannot verify models for migrated provider ${resolved.providerId}; provider selection was not changed.`,
      { cause: error },
    );
  }

  const proven = resolveManagedGooseProviderSelection(config, selection, {
    targetModelIds: supportedModelIds,
    targetInventoryValidated: true,
  });
  if (resolved.providerId === selection.providerId) return proven;
  if (proven?.modelId) return proven;

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
