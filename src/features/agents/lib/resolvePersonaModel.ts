import {
  resolveConcreteModelProviderId,
  resolveModelProviderId,
} from "@/features/providers/lib/modelProviderResolution";
import { normalizeConcreteModelId } from "@/shared/lib/modelIdentity";
import type { Persona } from "@/shared/types/agents";
import type { ProviderCatalogEntry } from "@/shared/types/providers";

interface PersonaModelOption {
  id: string;
  name?: string;
  displayName?: string;
  providerId?: string;
}

interface CurrentModelSelection {
  modelId?: string;
  modelProviderId?: string;
}

interface ResolvedPersonaModel {
  modelId: string;
  modelName: string;
  modelProviderId: string;
}

export function resolvePersonaModel(
  persona: Pick<Persona, "provider" | "model" | "modelProviderId">,
  harnessId: string,
  models: readonly PersonaModelOption[],
  catalogEntries: ProviderCatalogEntry[],
  currentSelection?: CurrentModelSelection,
): ResolvedPersonaModel | undefined {
  const modelId = normalizeConcreteModelId(persona.model);
  if (!modelId) return undefined;

  const matchingModels = models.filter((model) => model.id === modelId);
  const currentModelProviderId =
    currentSelection?.modelId === modelId
      ? currentSelection.modelProviderId
      : undefined;
  const legacyPersonaModelProviderId = resolveConcreteModelProviderId(
    persona.provider,
    harnessId,
    catalogEntries,
  );
  const modelProviderId = resolveModelProviderId({
    harnessId,
    modelId,
    hintedModelProviderId:
      persona.modelProviderId ??
      legacyPersonaModelProviderId ??
      currentModelProviderId,
    models,
    catalogEntries,
  });
  if (!modelProviderId) return undefined;

  const model = matchingModels.find(
    (candidate) =>
      !candidate.providerId ||
      resolveConcreteModelProviderId(
        candidate.providerId,
        harnessId,
        catalogEntries,
      ) === modelProviderId,
  );

  return {
    modelId,
    modelName: model?.displayName ?? model?.name ?? modelId,
    modelProviderId,
  };
}
