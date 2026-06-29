import {
  DEFAULT_RUNTIME_MODEL_ID,
  DEFAULT_RUNTIME_MODEL_PROVIDER_ID,
} from "@/shared/runtime-config/schema";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";

export function getDefaultGooseModelProviderId(): string {
  return useRuntimeConfigStore.getState().config.goose.defaultModelProviderId;
}

export function getDefaultGooseModelId(): string | undefined {
  return useRuntimeConfigStore.getState().config.goose.defaultModelId;
}

export function getDefaultGooseModelName(modelId: string): string {
  const config = useRuntimeConfigStore.getState().config;
  const providerId = config.goose.defaultModelProviderId;
  return (
    config.goose.modelProviders
      .find((provider) => provider.id === providerId)
      ?.models.find((model) => model.id === modelId)?.name ?? modelId
  );
}

export { DEFAULT_RUNTIME_MODEL_ID, DEFAULT_RUNTIME_MODEL_PROVIDER_ID };
