import type { ModelExecutionTarget } from "./sessionExecutionTarget";
import { create } from "zustand";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { useChatSessionStore } from "../stores/chatSessionStore";

export const usePendingAutoModeStore = create<{
  modeId: string | null | undefined;
  setModeId: (modeId: string | null | undefined) => void;
}>((set) => ({ modeId: undefined, setModeId: (modeId) => set({ modeId }) }));

export function getSelectedAutoModeId(
  sessionId?: string | null,
): string | null | undefined {
  if (sessionId)
    return useChatSessionStore.getState().getSession(sessionId)?.autoModeId;
  const pendingModeId = usePendingAutoModeStore.getState().modeId;
  return pendingModeId === undefined
    ? useRuntimeConfigStore.getState().config.goose.autoRouting?.defaultModeId
    : pendingModeId;
}

export function selectAutoMode(
  sessionId: string | null,
  modeId: string | null,
): void {
  if (sessionId)
    useChatSessionStore.getState().patchSession(sessionId, {
      autoModeId: modeId,
      autoRoutingDecision: undefined,
    });
  else usePendingAutoModeStore.getState().setModeId(modeId);
}

export function getAutoModeExecutionTarget(
  modeId: string | null | undefined,
): ModelExecutionTarget | undefined {
  const mode = useRuntimeConfigStore
    .getState()
    .config.goose.autoRouting?.modes.find((mode) => mode.id === modeId);
  if (!mode) return undefined;
  return {
    harnessId: "goose",
    modelProviderId: mode.modelProviderId,
    modelId: mode.fallback.modelId,
    modelName: mode.fallback.modelId,
  };
}
