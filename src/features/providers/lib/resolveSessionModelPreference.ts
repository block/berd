import {
  resolveSessionModelPreference,
  sanitizeSessionModelPreference,
  type SessionModelPreference,
} from "@/features/chat/lib/sessionModelPreference";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { useDefaultProviderReadinessStore } from "@/features/providers/stores/defaultProviderReadinessStore";
import { resolveAgentProviderCatalogIdStrict } from "@/features/providers/providerCatalog";
import { checkAllProviderStatus } from "@/features/providers/api/credentials";

function gooseDefaultPreference(): SessionModelPreference | null {
  const readiness = useDefaultProviderReadinessStore.getState().readiness;
  if (readiness?.status !== "ready" || !readiness.modelId) {
    return null;
  }
  return {
    providerId: readiness.providerId,
    modelId: readiness.modelId,
    modelName: readiness.modelId,
  };
}

// Disconnecting a provider deletes its model-cache entry without touching
// stored model preferences, so an empty cache is ambiguous: not fetched yet,
// or the provider's credentials were removed. Only a concrete provider that
// the backend explicitly reports as unconfigured counts as disconnected;
// agent harnesses, unknown providers, and status-read failures stay fail-open.
async function isProviderDisconnected(providerId: string): Promise<boolean> {
  if (
    providerId === "goose" ||
    resolveAgentProviderCatalogIdStrict(providerId)
  ) {
    return false;
  }

  const readiness = useDefaultProviderReadinessStore.getState().readiness;
  if (readiness?.status === "ready" && readiness.providerId === providerId) {
    return false;
  }

  try {
    const statuses = await checkAllProviderStatus();
    const status = statuses.find(
      (candidate) => candidate.providerId === providerId,
    );
    return status ? !status.isConfigured : false;
  } catch {
    return false;
  }
}

export async function resolveSupportedSessionModelPreference(
  providerId: string,
  _unusedInventoryEntries: unknown,
  preferredModel?: string,
): Promise<SessionModelPreference> {
  let sessionModelPreference = resolveSessionModelPreference({
    providerId,
    preferredModel,
  });

  if (providerId === "goose" && !sessionModelPreference.modelId) {
    sessionModelPreference = gooseDefaultPreference() ?? sessionModelPreference;
  }

  if (!sessionModelPreference.modelId) {
    return sessionModelPreference;
  }

  const models = useProviderModelCacheStore
    .getState()
    .getModelsForProvider(sessionModelPreference.providerId);

  if (models.length > 0) {
    return sanitizeSessionModelPreference(sessionModelPreference, { models });
  }

  if (!(await isProviderDisconnected(sessionModelPreference.providerId))) {
    return sessionModelPreference;
  }

  if (providerId === "goose") {
    const fallback = gooseDefaultPreference();
    if (fallback && fallback.providerId !== sessionModelPreference.providerId) {
      const fallbackModels = useProviderModelCacheStore
        .getState()
        .getModelsForProvider(fallback.providerId);
      return sanitizeSessionModelPreference(fallback, {
        models: fallbackModels,
      });
    }
  }

  return { providerId };
}
