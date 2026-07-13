import { setStoredModelPreference } from "@/features/chat/lib/modelPreferences";
import { getClient } from "@/shared/api/acpConnection";
import { SETUP_CATALOG_BYO_KEY_PROVIDER_IDS } from "./api/catalog";
import { checkAllProviderStatus } from "./api/credentials";
import { useProviderModelCacheStore } from "./stores/providerModelCacheStore";
import { useDefaultProviderReadinessStore } from "./stores/defaultProviderReadinessStore";

const BYO_KEY_PROVIDER_ID_SET = new Set<string>(
  SETUP_CATALOG_BYO_KEY_PROVIDER_IDS,
);

/**
 * Configured bring-your-own-key providers usable for default-provider
 * recovery. Only BYO key providers count: the provider readiness gate exists
 * to require a user-provided key, so providers preconfigured by runtime
 * config (e.g. databricks_v2 via endpointEnv) must not satisfy it.
 */
function getConfiguredByoKeyProviderIdsFromStatuses(
  statuses: Awaited<ReturnType<typeof checkAllProviderStatus>>,
): string[] {
  return statuses.flatMap((status) =>
    status.isConfigured && BYO_KEY_PROVIDER_ID_SET.has(status.providerId)
      ? [status.providerId]
      : [],
  );
}

/**
 * Recovery path for installs where a BYO key provider is configured but no
 * backend default is saved (e.g. credentials retained across a reset). Saves
 * the first configured BYO provider as the backend default so the readiness
 * gate clears with defaults properly persisted. Returns null when no
 * configured BYO provider exists.
 */
export async function saveDefaultProviderSelectionFromConfiguredProvider(): Promise<{
  providerId: string;
  modelId?: string;
  modelName?: string;
} | null> {
  const providerIds = getConfiguredByoKeyProviderIdsFromStatuses(
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
