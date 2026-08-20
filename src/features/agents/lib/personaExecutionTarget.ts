import {
  normalizeSessionExecutionTarget,
  type SessionExecutionTarget,
} from "@/features/chat/lib/sessionExecutionTarget";
import {
  canonicalProviderCatalogIdFromEntries,
  resolveAgentProviderCatalogIdStrictFromEntries,
  resolveModelProviderCatalogIdStrictFromEntries,
} from "@/features/providers/providerCatalog";
import { normalizeProviderKey } from "@/features/providers/lib/providerKey";
import { normalizeConcreteModelId } from "@/shared/lib/modelIdentity";
import type { Persona, UpdatePersonaRequest } from "@/shared/types/agents";
import type { ProviderCatalogEntry } from "@/shared/types/providers";

interface AvailableHarness {
  id: string;
  label?: string;
}

interface AvailableModel {
  id: string;
  name?: string;
  displayName?: string;
  providerId?: string;
}

export interface PersonaTargetContext {
  providers: readonly AvailableHarness[];
  models: readonly AvailableModel[];
  getModelsForHarness?: (harnessId: string) => readonly AvailableModel[];
  /** Live inventory models, separate from display/advisory candidates. */
  getProvenModelsForHarness?: (harnessId: string) => readonly AvailableModel[];
  /** Whether the model inventory for a provider/harness is authoritative. */
  isModelInventoryAuthoritative?: (providerId: string) => boolean;
  catalogEntries: ProviderCatalogEntry[];
}

const INTERNAL_DATABRICKS_KEYS = new Set([
  "databricks",
  "databricks_v2",
  "databricks_ai_gateway",
]);

function canonicalModelProviderId(
  providerId: string,
  catalogEntries: ProviderCatalogEntry[],
): string {
  if (INTERNAL_DATABRICKS_KEYS.has(normalizeProviderKey(providerId))) {
    return "databricks_v2";
  }
  return canonicalProviderCatalogIdFromEntries(catalogEntries, providerId);
}

export function personaHarnessId(
  providerId: string | undefined,
  providers: readonly AvailableHarness[],
  catalogEntries: ProviderCatalogEntry[],
): string | undefined {
  if (!providerId) return undefined;
  const normalized = normalizeProviderKey(providerId);
  if (normalized === "goose" || normalized === "berd") return "goose";
  if (
    INTERNAL_DATABRICKS_KEYS.has(normalized) ||
    resolveModelProviderCatalogIdStrictFromEntries(catalogEntries, providerId)
  ) {
    return "goose";
  }

  return (
    resolveAgentProviderCatalogIdStrictFromEntries(
      catalogEntries,
      providerId,
    ) ??
    providers.find(
      (provider) =>
        normalizeProviderKey(provider.id) === normalized ||
        (provider.label && normalizeProviderKey(provider.label) === normalized),
    )?.id
  );
}

function isAgentProviderId(
  providerId: string,
  catalogEntries: ProviderCatalogEntry[],
): boolean {
  return (
    resolveAgentProviderCatalogIdStrictFromEntries(
      catalogEntries,
      providerId,
    ) !== null
  );
}

function persistedModelProviderId(
  persona: Pick<Persona, "provider" | "modelProviderId">,
  harnessId: string,
  catalogEntries: ProviderCatalogEntry[],
): string | undefined {
  // A non-Goose harness is its own provider boundary. Its persisted model
  // provider is display metadata from an older representation, never an
  // independent provider that may be sent to Goose.
  if (harnessId !== "goose") return harnessId;

  const persistedProviderId = persona.modelProviderId?.trim();
  if (
    persistedProviderId &&
    !isAgentProviderId(persistedProviderId, catalogEntries)
  ) {
    return canonicalModelProviderId(persistedProviderId, catalogEntries);
  }
  if (
    persona.provider?.trim() &&
    (INTERNAL_DATABRICKS_KEYS.has(normalizeProviderKey(persona.provider)) ||
      resolveModelProviderCatalogIdStrictFromEntries(
        catalogEntries,
        persona.provider,
      ))
  ) {
    return canonicalModelProviderId(persona.provider, catalogEntries);
  }
  return undefined;
}

/**
 * Convert canonical saved agent metadata into PR #1085's runtime target.
 * An incomplete legacy target is no override; callers must leave chat state alone.
 */
function resolvePersonaExecutionTargetValue(
  persona:
    | Pick<Persona, "provider" | "modelProviderId" | "model">
    | null
    | undefined,
  {
    providers,
    models,
    getModelsForHarness,
    getProvenModelsForHarness,
    isModelInventoryAuthoritative,
    catalogEntries,
  }: PersonaTargetContext,
): SessionExecutionTarget | undefined {
  const harnessId = personaHarnessId(
    persona?.provider,
    providers,
    catalogEntries,
  );
  if (!harnessId) return undefined;

  const availableModels = getModelsForHarness?.(harnessId) ?? models;
  const provenModels =
    getProvenModelsForHarness?.(harnessId) ?? availableModels;
  const modelId = normalizeConcreteModelId(persona?.model);
  if (!modelId) return undefined;
  let modelProviderId = persistedModelProviderId(
    persona ?? {},
    harnessId,
    catalogEntries,
  );

  // Compatibility read until the migration write completes.
  if (modelId && !modelProviderId && harnessId === "goose") {
    const matches = new Set(
      provenModels.flatMap((model) =>
        model.id === modelId && model.providerId
          ? [canonicalModelProviderId(model.providerId, catalogEntries)]
          : [],
      ),
    );
    if (matches.size === 1) {
      modelProviderId = matches.values().next().value;
    }
  }

  if (modelId && !modelProviderId) return undefined;

  const matchingModel = availableModels.find(
    (model) =>
      model.id === modelId &&
      (!model.providerId ||
        canonicalModelProviderId(model.providerId, catalogEntries) ===
          modelProviderId),
  );
  const provenModel = provenModels.find(
    (model) =>
      model.id === modelId &&
      (!model.providerId ||
        canonicalModelProviderId(model.providerId, catalogEntries) ===
          modelProviderId),
  );
  const inventoryIsAuthoritative =
    isModelInventoryAuthoritative?.(modelProviderId ?? harnessId) ?? false;

  if (modelId && !provenModel && inventoryIsAuthoritative) {
    // Preserve the saved configuration for repair, but do not expose an
    // incomplete execution target: agents require both provider and model.
    return undefined;
  }

  return normalizeSessionExecutionTarget({
    harnessId,
    modelProviderId,
    modelId,
    modelName: matchingModel?.displayName ?? matchingModel?.name ?? modelId,
  });
}

export type PersonaExecutionResolution =
  | { status: "absent"; target?: undefined }
  | { status: "invalid"; target?: undefined }
  | { status: "valid"; target: SessionExecutionTarget };

/** Distinguish legacy absence from saved metadata that cannot be invoked safely. */
export function resolvePersonaExecutionTarget(
  persona:
    | Pick<Persona, "provider" | "modelProviderId" | "model">
    | null
    | undefined,
  context: PersonaTargetContext,
): PersonaExecutionResolution {
  const hasSavedTarget = Boolean(
    persona?.provider || persona?.modelProviderId || persona?.model,
  );
  if (!hasSavedTarget) return { status: "absent" };
  const target = resolvePersonaExecutionTargetValue(persona, context);
  return target ? { status: "valid", target } : { status: "invalid" };
}

export function personaExecutionTarget(
  persona:
    | Pick<Persona, "provider" | "modelProviderId" | "model">
    | null
    | undefined,
  context: PersonaTargetContext,
): SessionExecutionTarget | undefined {
  const resolution = resolvePersonaExecutionTarget(persona, context);
  return resolution.status === "valid" ? resolution.target : undefined;
}

/**
 * Produce the durable repair for legacy agent metadata after provider inventory
 * has refreshed. `null` means the saved target is already canonical.
 */
export function personaTargetMigration(
  persona: Pick<Persona, "provider" | "modelProviderId" | "model">,
  context: PersonaTargetContext,
): Pick<UpdatePersonaRequest, "provider" | "modelProviderId" | "model"> | null {
  const hasSavedTarget = Boolean(
    persona.provider || persona.modelProviderId || persona.model,
  );
  if (!hasSavedTarget) return null;

  const target = personaExecutionTarget(persona, context);
  if (!target) {
    const modelId = normalizeConcreteModelId(persona.model);
    const matchingProviderIds = new Set(
      context.models.flatMap((model) =>
        modelId && model.id === modelId && model.providerId
          ? [canonicalModelProviderId(model.providerId, context.catalogEntries)]
          : [],
      ),
    );
    const unknownHarness =
      Boolean(persona.provider) &&
      !personaHarnessId(
        persona.provider,
        context.providers,
        context.catalogEntries,
      );
    const persistedAgentProviderForGoose =
      personaHarnessId(
        persona.provider,
        context.providers,
        context.catalogEntries,
      ) === "goose" &&
      Boolean(
        persona.modelProviderId &&
          isAgentProviderId(persona.modelProviderId, context.catalogEntries),
      );
    // Clear only when the saved data itself proves it cannot form one target.
    // No inventory match may be a transient availability problem, so preserve
    // that legacy metadata until a later authoritative refresh can repair it.
    return unknownHarness ||
      persistedAgentProviderForGoose ||
      matchingProviderIds.size > 1
      ? { provider: null, modelProviderId: null, model: null }
      : null;
  }

  const canonicalProvider = target.harnessId;
  const canonicalModelProvider = target.modelProviderId ?? null;
  const canonicalModel = target.modelId ?? null;
  if (
    persona.provider === canonicalProvider &&
    (persona.modelProviderId ?? null) === canonicalModelProvider &&
    (normalizeConcreteModelId(persona.model) ?? null) === canonicalModel
  ) {
    return null;
  }

  return {
    provider: canonicalProvider,
    modelProviderId: canonicalModelProvider,
    model: canonicalModel,
  };
}
