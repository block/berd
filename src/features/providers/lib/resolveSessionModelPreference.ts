import {
  resolveSessionModelPreference,
  sanitizeSessionModelPreference,
  type SessionModelPreference,
} from "@/features/chat/lib/sessionModelPreference";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { useDefaultProviderReadinessStore } from "@/features/providers/stores/defaultProviderReadinessStore";
import {
  getProviderCatalog,
  resolveAgentProviderCatalogIdStrict,
} from "@/features/providers/providerCatalog";
import { checkAllProviderStatus } from "@/features/providers/api/credentials";
import {
  resolveConcreteModelProviderId,
  resolveModelProviderId,
} from "./modelProviderResolution";

export function resolveCachedGooseModelProviderId(
  modelId: string,
): string | null {
  const modelCache = useProviderModelCacheStore.getState();
  const readiness = useDefaultProviderReadinessStore.getState().readiness;
  const hintedModelProviderId =
    readiness?.status === "ready" && readiness.modelId === modelId
      ? readiness.providerId
      : undefined;
  const models = [...modelCache.providers].flatMap(([providerId, entry]) =>
    entry.models.map((model) => ({
      ...model,
      providerId: model.providerId ?? providerId,
    })),
  );
  return (
    resolveModelProviderId({
      harnessId: "goose",
      modelId,
      hintedModelProviderId,
      models,
      catalogEntries: getProviderCatalog(),
    }) ?? null
  );
}

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
  preferredModel?: string,
): Promise<SessionModelPreference> {
  let sessionModelPreference = resolveSessionModelPreference({
    providerId,
    preferredModel,
  });

  if (
    providerId === "goose" &&
    sessionModelPreference.modelId &&
    !resolveConcreteModelProviderId(
      sessionModelPreference.providerId,
      "goose",
      getProviderCatalog(),
    )
  ) {
    const modelProviderId = resolveCachedGooseModelProviderId(
      sessionModelPreference.modelId,
    );
    if (!modelProviderId) {
      return { providerId };
    }
    sessionModelPreference = {
      ...sessionModelPreference,
      providerId: modelProviderId,
    };
  }

  const modelCache = useProviderModelCacheStore.getState();

  // A configured default is synthesized intent. Unlike an explicit preference,
  // it cannot survive without a successful inventory proof.
  if (providerId === "goose" && !sessionModelPreference.modelId) {
    const fallback = gooseDefaultPreference();
    if (!fallback) return sessionModelPreference;
    if (!modelCache.isModelInventoryAuthoritative(fallback.providerId)) {
      return { providerId };
    }
    return sanitizeSessionModelPreference(fallback, {
      models: modelCache.getProvenModelsForProvider(fallback.providerId),
    });
  }

  if (!sessionModelPreference.modelId) {
    return sessionModelPreference;
  }

  const modelProviderId = sessionModelPreference.providerId;

  if (modelCache.isModelInventoryAuthoritative(modelProviderId)) {
    return sanitizeSessionModelPreference(sessionModelPreference, {
      models: modelCache.getProvenModelsForProvider(modelProviderId),
    });
  }

  if (!(await isProviderDisconnected(sessionModelPreference.providerId))) {
    return sessionModelPreference;
  }

  if (providerId === "goose") {
    const fallback = gooseDefaultPreference();
    if (
      fallback &&
      fallback.providerId !== sessionModelPreference.providerId &&
      modelCache.isModelInventoryAuthoritative(fallback.providerId)
    ) {
      return sanitizeSessionModelPreference(fallback, {
        models: modelCache.getProvenModelsForProvider(fallback.providerId),
      });
    }
  }

  return { providerId };
}
