import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";

export function getDefaultGooseModelProviderId(): string | undefined {
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
