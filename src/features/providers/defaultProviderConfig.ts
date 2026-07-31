import { setStoredModelPreference } from "@/features/chat/lib/modelPreferences";
import { getClient } from "@/shared/api/acpConnection";
import { checkAllProviderStatus, listProviderSecrets } from "./api/credentials";
import { getModelProviders } from "./providerCatalog";
import {
  getCredentialedProviderIds,
  isCredentialedProvider,
} from "./lib/providerConnectionPolicy";
import { useProviderModelCacheStore } from "./stores/providerModelCacheStore";
import { useDefaultProviderReadinessStore } from "./stores/defaultProviderReadinessStore";

/**
 * Providers eligible for default-provider recovery: Goose reports them
 * configured AND either a stored Goose credential exists (API key or OAuth
 * token) or the provider is a user-created custom provider. Merely
 * "Configured" non-secret endpoints and runtime-managed providers (e.g.
 * databricks_v2 via runtime config) never satisfy the readiness gate.
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
  return getModelProviders()
    .filter(
      (provider) =>
        configuredIds.has(provider.id) &&
        (isCredentialedProvider(provider, credentialedIds) ||
          provider.customProvider === true),
    )
    .map((provider) => provider.id);
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
  const providerIds = await getIntentionalConfiguredProviderIds(
    await checkAllProviderStatus(),
  );
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
  const model =
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
