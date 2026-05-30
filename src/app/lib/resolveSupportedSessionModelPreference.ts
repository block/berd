import {
  resolveSessionModelPreference,
  sanitizeSessionModelPreference,
  type SessionModelPreference,
} from "@/features/chat/lib/sessionModelPreference";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";

export async function resolveSupportedSessionModelPreference(
  providerId: string,
  _unusedInventoryEntries: unknown,
  preferredModel?: string,
): Promise<SessionModelPreference> {
  const sessionModelPreference = resolveSessionModelPreference({
    providerId,
    preferredModel,
  });

  if (!sessionModelPreference.modelId) {
    return sessionModelPreference;
  }

  const models = useProviderModelCacheStore
    .getState()
    .getModelsForProvider(sessionModelPreference.providerId);

  return sanitizeSessionModelPreference(sessionModelPreference, { models });
}
