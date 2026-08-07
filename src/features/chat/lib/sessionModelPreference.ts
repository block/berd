import { resolveAgentProviderCatalogIdStrict } from "@/features/providers/providerCatalog";
import { getStoredModelPreferenceForProvider } from "./modelPreferences";
import { normalizeConcreteModelId } from "@/shared/lib/modelIdentity";

interface SessionModelPreferenceOptions {
  providerId: string;
  preferredModel?: string;
}

export interface SessionModelPreference {
  providerId: string;
  modelId?: string;
  modelName?: string;
}

interface ProviderModelsLike {
  models: Array<{
    id: string;
  }>;
}

export function resolveSessionModelPreference({
  providerId,
  preferredModel,
}: SessionModelPreferenceOptions): SessionModelPreference {
  const concretePreferredModel = normalizeConcreteModelId(preferredModel);
  if (concretePreferredModel) {
    return {
      providerId,
      modelId: concretePreferredModel,
      modelName: concretePreferredModel,
    };
  }

  const storedModelPreference = getStoredModelPreferenceForProvider(providerId);
  if (!storedModelPreference) {
    return { providerId };
  }

  if (resolveAgentProviderCatalogIdStrict(providerId)) {
    return {
      providerId: storedModelPreference.providerId ?? providerId,
      modelId: storedModelPreference.modelId,
      modelName: storedModelPreference.modelName,
    };
  }

  if (
    storedModelPreference.providerId &&
    storedModelPreference.providerId !== providerId
  ) {
    return { providerId };
  }

  return {
    providerId,
    modelId: storedModelPreference.modelId,
    modelName: storedModelPreference.modelName,
  };
}

export function sanitizeSessionModelPreference(
  preference: SessionModelPreference,
  providerModels?: ProviderModelsLike | null,
): SessionModelPreference {
  if (!preference.modelId || !providerModels) {
    return preference;
  }

  if (providerModels.models.length === 0) {
    return preference;
  }

  if (providerModels.models.some((model) => model.id === preference.modelId)) {
    return preference;
  }

  return {
    providerId: preference.providerId,
  };
}
