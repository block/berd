import { normalizeConcreteModelId } from "@/shared/lib/modelIdentity";

interface HarnessExecutionTarget {
  readonly harnessId: string;
  readonly modelProviderId?: never;
  readonly modelId?: never;
  readonly modelName?: never;
}

interface ModelProviderExecutionTarget {
  readonly harnessId: string;
  readonly modelProviderId: string;
  readonly modelId?: never;
  readonly modelName?: never;
}

export interface ModelExecutionTarget {
  readonly harnessId: string;
  readonly modelProviderId: string;
  readonly modelId: string;
  readonly modelName: string;
}

export type SessionExecutionTarget =
  | HarnessExecutionTarget
  | ModelProviderExecutionTarget
  | ModelExecutionTarget;

export type ModelLessSessionExecutionTarget =
  | HarnessExecutionTarget
  | ModelProviderExecutionTarget;

interface SessionExecutionTargetInput {
  harnessId: string;
  modelProviderId?: string | null;
  modelId?: string | null;
  modelName?: string | null;
}

interface AgentModelSelectionInput {
  modelProviderId: string;
  modelId?: string | null;
  modelName?: string | null;
}

interface SessionExecutionModelSnapshot {
  modelId: string;
  modelName: string;
}

export function normalizeSessionExecutionTarget(
  target: SessionExecutionTargetInput,
): SessionExecutionTarget {
  const harnessId = target.harnessId.trim();
  if (!harnessId) {
    throw new Error("Session execution target requires a harness id.");
  }

  const modelProviderId = target.modelProviderId?.trim() || undefined;
  const modelId = normalizeConcreteModelId(target.modelId);
  if (modelId && !modelProviderId) {
    throw new Error("Session model selection requires a model provider id.");
  }
  if (modelId && harnessId === "goose" && modelProviderId === harnessId) {
    throw new Error(
      "Goose model selection requires a concrete model provider.",
    );
  }

  if (!modelProviderId) {
    return { harnessId };
  }
  if (!modelId) {
    return { harnessId, modelProviderId };
  }
  return {
    harnessId,
    modelProviderId,
    modelId,
    modelName: target.modelName || modelId,
  };
}

export function targetFromAgentModelSelection(
  harnessId: string,
  model?: AgentModelSelectionInput | null,
): SessionExecutionTarget {
  return normalizeSessionExecutionTarget({
    harnessId,
    modelProviderId: model?.modelProviderId,
    modelId: model?.modelId,
    modelName: model?.modelName,
  });
}

/** Materialize a model snapshot only when its provider identity is known. */
export function materializeSessionExecutionModel(
  target: SessionExecutionTarget | null | undefined,
  model: SessionExecutionModelSnapshot,
): ModelExecutionTarget | null {
  if (!target) {
    return null;
  }
  const modelProviderId =
    target.modelProviderId ??
    (target.harnessId === "goose" ? undefined : target.harnessId);
  if (!modelProviderId) {
    return null;
  }

  const materialized = normalizeSessionExecutionTarget({
    ...target,
    modelProviderId,
    modelId: model.modelId,
    modelName: model.modelName,
  });
  return isModelExecutionTarget(materialized) ? materialized : null;
}

export function sameSessionExecutionTarget(
  left: SessionExecutionTarget | null | undefined,
  right: SessionExecutionTarget | null | undefined,
): boolean {
  return (
    left?.harnessId === right?.harnessId &&
    left?.modelProviderId === right?.modelProviderId &&
    left?.modelId === right?.modelId
  );
}

export function isModelExecutionTarget(
  target: SessionExecutionTarget,
): target is ModelExecutionTarget {
  return target.modelId !== undefined;
}
