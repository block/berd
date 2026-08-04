import {
  resolveSessionModelPreference,
  sanitizeSessionModelPreference,
  type SessionModelPreference,
} from "@/features/chat/lib/sessionModelPreference";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { useDefaultProviderReadinessStore } from "@/features/providers/stores/defaultProviderReadinessStore";

export function resolveSupportedSessionModelPreference(
  providerId: string,
  _unusedInventoryEntries: unknown,
  preferredModel?: string,
): SessionModelPreference {
  let sessionModelPreference = resolveSessionModelPreference({
    providerId,
    preferredModel,
  });

  if (providerId === "goose" && !sessionModelPreference.modelId) {
    const readiness = useDefaultProviderReadinessStore.getState().readiness;
    if (readiness?.status === "ready" && readiness.modelId) {
      sessionModelPreference = {
        providerId: readiness.providerId,
        modelId: readiness.modelId,
        modelName: readiness.modelId,
      };
    }
  }

  if (!sessionModelPreference.modelId) {
    return sessionModelPreference;
  }

  const models = useProviderModelCacheStore
    .getState()
    .getModelsForProvider(sessionModelPreference.providerId);

  return sanitizeSessionModelPreference(sessionModelPreference, { models });
}
