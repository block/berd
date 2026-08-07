import { CURATED_PROVIDER_CATALOG } from "@/features/providers/curatedProviders";
import { canonicalProviderCatalogIdFromEntries } from "@/features/providers/providerCatalog";
import { resolveCachedGooseModelProviderId } from "@/features/providers/lib/resolveSessionModelPreference";
import { normalizeConcreteModelId } from "@/shared/lib/modelIdentity";
import {
  normalizeSessionExecutionTarget,
  targetFromAgentModelSelection,
  type SessionExecutionTarget,
} from "./sessionExecutionTarget";

type GooseServeSessionSelection = {
  providerId?: string;
  modelId?: string;
  modelName?: string;
};

interface GooseServeTargetContext {
  defaultHarnessId: string;
  knownHarnessIds: readonly string[];
}

const GOOSE_SERVE_TARGET_CONTEXT: GooseServeTargetContext = {
  defaultHarnessId: "goose",
  knownHarnessIds: CURATED_PROVIDER_CATALOG.filter(
    (provider) => provider.category === "agent",
  ).map((provider) => provider.id),
};

function canonicalProviderId(providerId: string): string {
  return canonicalProviderCatalogIdFromEntries(
    CURATED_PROVIDER_CATALOG,
    providerId,
  );
}

function executionTargetFromGooseServeSelection(
  selection: GooseServeSessionSelection,
  context: GooseServeTargetContext,
): SessionExecutionTarget {
  const providerId = selection.providerId || undefined;
  const knownHarnessId =
    providerId &&
    (providerId === context.defaultHarnessId ||
      context.knownHarnessIds.includes(providerId))
      ? providerId
      : undefined;
  const harnessId = knownHarnessId ?? context.defaultHarnessId;

  if (!providerId) {
    return normalizeSessionExecutionTarget({
      harnessId,
      modelId: selection.modelId,
      modelName: selection.modelName,
    });
  }
  if (providerId === context.defaultHarnessId) {
    return normalizeSessionExecutionTarget({ harnessId });
  }

  return targetFromAgentModelSelection(
    harnessId,
    knownHarnessId && !normalizeConcreteModelId(selection.modelId)
      ? undefined
      : {
          modelProviderId: providerId,
          modelId: selection.modelId,
          modelName: selection.modelName,
        },
  );
}

export function gooseServeSelectionFromExecutionTarget(
  target: SessionExecutionTarget | null | undefined,
): GooseServeSessionSelection {
  if (!target) {
    return {};
  }
  return {
    providerId:
      target.harnessId === "goose"
        ? (target.modelProviderId ?? target.harnessId)
        : target.harnessId,
    modelId: target.modelId,
    modelName: target.modelName,
  };
}

/** Converts untrusted persisted/ACP provider fields into a canonical target. */
export function executionTargetFromGooseServeBoundary(
  selection: GooseServeSessionSelection,
  fallbackTarget?: SessionExecutionTarget,
): SessionExecutionTarget {
  const fallbackSelection =
    gooseServeSelectionFromExecutionTarget(fallbackTarget);
  const providerId = selection.providerId ?? fallbackSelection.providerId;
  const canonicalId = providerId ? canonicalProviderId(providerId) : undefined;

  return executionTargetFromGooseServeSelection(
    {
      providerId: canonicalId,
      // A model without any provider identity is not actionable. Ignore it
      // instead of letting one legacy record abort queue/session hydration.
      modelId: canonicalId ? selection.modelId : undefined,
      modelName: canonicalId ? selection.modelName : undefined,
    },
    GOOSE_SERVE_TARGET_CONTEXT,
  );
}

/** Converts ACP discovery metadata without inventing a renderer-owned target. */
export function executionTargetFromGooseServeSession(
  selection: GooseServeSessionSelection,
): SessionExecutionTarget | undefined {
  const modelId = normalizeConcreteModelId(selection.modelId);
  const providerId = selection.providerId
    ? canonicalProviderId(selection.providerId)
    : undefined;

  if (modelId && (!providerId || providerId === "goose")) {
    const modelProviderId = resolveCachedGooseModelProviderId(modelId);
    if (!modelProviderId) return undefined;
    return executionTargetFromGooseServeSelection(
      {
        providerId: modelProviderId,
        modelId,
        modelName: selection.modelName,
      },
      GOOSE_SERVE_TARGET_CONTEXT,
    );
  }
  if (!providerId) return undefined;

  return executionTargetFromGooseServeSelection(
    {
      providerId,
      modelId,
      modelName: selection.modelName,
    },
    GOOSE_SERVE_TARGET_CONTEXT,
  );
}
