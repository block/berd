import type { ModelOption } from "../types";
import {
  modelDisplayNameFromId,
  normalizedGooseModelDisplayName,
} from "@/features/providers/lib/modelRecommendations";

interface ModelDisplayLabelOptions {
  currentModelId?: string | null;
  currentModelName?: string | null;
  currentModelProviderId?: string | null;
  availableModels?: ModelOption[];
}

interface PickerTriggerLabelOptions extends ModelDisplayLabelOptions {
  selectedAgentLabel?: string | null;
}

function normalizeLabel(label?: string | null) {
  const trimmed = label?.trim();
  return trimmed ? trimmed : null;
}

function getModelDisplayName(model: ModelOption) {
  return normalizeLabel(model.displayName) ?? normalizeLabel(model.name);
}

function getDefaultAvailableModelLabel(availableModels: ModelOption[] = []) {
  const model =
    availableModels.find((candidate) => candidate.recommended) ??
    availableModels[0];

  return model ? getModelDisplayName(model) : null;
}

function getExplicitModelIdLabel(
  modelId?: string | null,
  modelProviderId?: string | null,
) {
  const selectedModelId = normalizeLabel(modelId);
  if (!selectedModelId) {
    return null;
  }

  if (
    modelProviderId === "databricks_v2" &&
    selectedModelId.indexOf(".") !== selectedModelId.lastIndexOf(".")
  ) {
    return modelDisplayNameFromId(modelProviderId, selectedModelId);
  }

  return selectedModelId.startsWith("goose-")
    ? normalizedGooseModelDisplayName(selectedModelId)
    : null;
}

function findSelectedAvailableModel({
  currentModelId,
  currentModelProviderId,
  availableModels = [],
}: Pick<
  ModelDisplayLabelOptions,
  "currentModelId" | "currentModelProviderId" | "availableModels"
>) {
  const selectedModelId = normalizeLabel(currentModelId);
  if (!selectedModelId) {
    return null;
  }

  const matches = availableModels.filter(
    (model) => model.id === selectedModelId,
  );
  if (matches.length === 0) {
    return null;
  }

  if (currentModelProviderId) {
    return (
      matches.find((model) => model.providerId === currentModelProviderId) ??
      matches.find((model) => !model.providerId) ??
      null
    );
  }

  return matches[0] ?? null;
}

export function resolveDisplayModelLabel({
  currentModelId,
  currentModelName,
  currentModelProviderId,
  availableModels = [],
}: ModelDisplayLabelOptions) {
  const availableModel = findSelectedAvailableModel({
    currentModelId,
    currentModelProviderId,
    availableModels,
  });
  const availableModelLabel = availableModel
    ? getModelDisplayName(availableModel)
    : null;
  if (availableModelLabel) {
    return availableModelLabel;
  }

  const selectedModelId = normalizeLabel(currentModelId);
  const rawModelName = normalizeLabel(currentModelName);
  const modelName =
    rawModelName &&
    currentModelProviderId === "databricks_v2" &&
    rawModelName.indexOf(".") !== rawModelName.lastIndexOf(".")
      ? modelDisplayNameFromId(currentModelProviderId, rawModelName)
      : rawModelName;
  if (modelName && modelName !== selectedModelId) {
    return modelName;
  }

  return (
    getExplicitModelIdLabel(selectedModelId, currentModelProviderId) ??
    (availableModels.length > 0 ? selectedModelId : null)
  );
}

export function resolvePickerTriggerLabel({
  selectedAgentLabel,
  availableModels = [],
  ...modelOptions
}: PickerTriggerLabelOptions) {
  return (
    resolveDisplayModelLabel({ ...modelOptions, availableModels }) ??
    getDefaultAvailableModelLabel(availableModels) ??
    normalizeLabel(selectedAgentLabel)
  );
}
