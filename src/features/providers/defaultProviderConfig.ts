import { getClient } from "@/shared/api/acpConnection";
import { checkAllProviderStatus, listProviderSecrets } from "./api/credentials";
import { getModelProviders } from "./providerCatalog";
import {
  getCredentialedProviderIds,
  isCredentialedProvider,
} from "./lib/providerConnectionPolicy";
import { connectedModelProviderIds } from "./lib/providerState";
import { useProviderModelCacheStore } from "./stores/providerModelCacheStore";
import { useDefaultProviderReadinessStore } from "./stores/defaultProviderReadinessStore";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { repairManagedGooseModelSelection } from "./lib/managedModelSelectionRepair";
import {
  getStoredModelPreference,
  setStoredModelPreference,
} from "@/features/chat/lib/modelPreferences";
import {
  getDefaultGooseModelId,
  getDefaultGooseModelName,
  getDefaultGooseModelProviderId,
} from "@/features/runtime-config/defaults";

export const MODEL_DISCOVERY_SECRET_LOOKUP_TIMEOUT_MS = 3_000;

async function listProviderSecretsForDiscovery() {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(
      () => resolve(null),
      MODEL_DISCOVERY_SECRET_LOOKUP_TIMEOUT_MS,
    );
  });

  try {
    return await Promise.race([listProviderSecrets(), timeout]);
  } catch {
    return null;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Providers eligible for default-provider recovery: Goose reports them
 * configured AND they have deliberate setup evidence: a stored Goose
 * credential, a user-created custom provider, or a distribution-managed
 * endpoint. Merely appearing in runtime inventory or having ambient/default
 * setup values does not satisfy the readiness gate.
 */
export async function getIntentionalConfiguredProviderIds(
  statuses: Awaited<ReturnType<typeof checkAllProviderStatus>>,
): Promise<string[]> {
  const configuredIds = new Set(
    statuses
      .filter((status) => status.isConfigured)
      .map((status) => status.providerId),
  );
  const credentialedIds = getCredentialedProviderIds(
    await listProviderSecrets(),
  );
  const runtimeConfiguredIds = new Set(
    useRuntimeConfigStore
      .getState()
      .config.goose.modelProviders.filter(
        (provider) => provider.endpointEnv != null,
      )
      .map((provider) => provider.id),
  );
  const connectionSnapshot = {
    configuredIds,
    credentialedIds,
    runtimeManagedIds: runtimeConfiguredIds,
  };
  return connectedModelProviderIds(
    getModelProviders().filter((provider) => configuredIds.has(provider.id)),
    connectionSnapshot,
  );
}

/**
 * Providers safe to probe for model inventory. A positive Goose status is
 * enough for discovery, while stored credentials also cover OAuth providers
 * whose field-only status probe cannot see the shared token cache. Unlike
 * default recovery, this only refreshes provider-local cache state and never
 * persists a provider selection.
 */
export async function getModelDiscoveryProviderIds(
  statuses: Awaited<ReturnType<typeof checkAllProviderStatus>>,
): Promise<string[]> {
  const configuredIds = new Set(
    statuses
      .filter((status) => status.isConfigured)
      .map((status) => status.providerId),
  );
  const secrets = await listProviderSecretsForDiscovery();
  const credentialedIds: ReadonlySet<string> = secrets
    ? getCredentialedProviderIds(secrets)
    : new Set();
  return getModelProviders()
    .filter(
      (provider) =>
        configuredIds.has(provider.id) ||
        isCredentialedProvider(provider, credentialedIds),
    )
    .map((provider) => provider.id);
}

export async function reconcileManagedDefaultProviderSelection(): Promise<{
  providerId: string;
  modelId?: string;
} | null> {
  const client = await getClient();
  const current = await client.goose.GooseUnstableDefaultsRead({});
  const resolved = await repairManagedGooseModelSelection(
    current,
    "goose_default",
  );
  if (!resolved) {
    return null;
  }

  if (
    current.providerId !== resolved.providerId ||
    current.modelId !== resolved.modelId
  ) {
    await client.goose.GooseUnstableDefaultsSave(resolved);
  }

  const preference = getStoredModelPreference("goose");
  const resolvedPreference = await repairManagedGooseModelSelection(
    preference ?? current,
    "berd_preference",
  );
  if (resolvedPreference?.modelId) {
    const modelId = resolvedPreference.modelId;
    setStoredModelPreference("goose", {
      providerId: resolvedPreference.providerId,
      modelId,
      modelName: getDefaultGooseModelName(modelId),
    });
  }

  return resolved;
}

/**
 * Recovery path for installs where a credential-backed provider is configured
 * but no backend default is saved (e.g. credentials retained across a reset).
 * Saves the first eligible provider as the backend default so the readiness
 * gate clears with defaults properly persisted. Returns null when no eligible
 * provider exists.
 */
export async function saveDefaultProviderSelectionFromConfiguredProvider(): Promise<{
  providerId: string;
  modelId?: string;
  modelName?: string;
} | null> {
  // Reads plainly (no `coalesce`): this decides what to *write* as the
  // default, and it runs after the startup readiness gate's read has settled.
  const providerIds = await getIntentionalConfiguredProviderIds(
    await checkAllProviderStatus(),
  );
  const runtimeDefaultProviderId = getDefaultGooseModelProviderId();
  if (runtimeDefaultProviderId) {
    providerIds.sort(
      (left, right) =>
        Number(right === runtimeDefaultProviderId) -
        Number(left === runtimeDefaultProviderId),
    );
  }
  let lastError: unknown;
  for (const providerId of providerIds) {
    try {
      return await saveDefaultProviderSelection(providerId);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) {
    throw lastError;
  }
  return null;
}

export async function saveDefaultProviderSelection(
  providerId: string,
): Promise<{ providerId: string; modelId?: string; modelName?: string }> {
  const modelCacheStore = useProviderModelCacheStore.getState();
  await modelCacheStore.refreshProviderModels(providerId, { force: true });

  const models = useProviderModelCacheStore
    .getState()
    .getModelsForProvider(providerId);
  const runtimeDefaultModelId =
    providerId === getDefaultGooseModelProviderId()
      ? getDefaultGooseModelId()
      : undefined;
  const model =
    models.find((candidate) => candidate.id === runtimeDefaultModelId) ??
    models.find((candidate) => candidate.recommended) ??
    models.find((candidate) => candidate.featured) ??
    models[0];

  if (!model) {
    throw new Error(
      "Could not load models for provider. Check provider setup and try again.",
    );
  }

  const modelName = model.displayName ?? model.name ?? model.id;
  const client = await getClient();
  await client.goose.GooseUnstableDefaultsSave({
    providerId,
    modelId: model.id,
  });

  setStoredModelPreference("goose", {
    providerId,
    modelId: model.id,
    modelName,
  });

  await useDefaultProviderReadinessStore.getState().refresh();

  return { providerId, modelId: model.id, modelName };
}
