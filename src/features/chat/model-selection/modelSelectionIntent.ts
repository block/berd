import { toast } from "sonner";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useChatSessionStore } from "../stores/chatSessionStore";
import { i18n } from "@/shared/i18n";

export type PreferredModelSelection = {
  id: string;
  name: string;
  providerId?: string;
  source: "default" | "explicit";
};

export interface PreviousModelSelection {
  providerId?: string;
  modelId?: string;
  modelName?: string;
}

export interface ModelSelectionApplyOptions {
  nextProject?: ProjectInfo | null;
  nextWorkspacePath?: string | null;
  requestId?: string;
}

export type ApplySessionModelSelection = (
  providerId: string,
  modelSelection: PreferredModelSelection,
  requestId: string,
  options?: ModelSelectionApplyOptions,
) => Promise<boolean>;

type PrepareSelectedProvider = (
  providerId: string,
  options?: ModelSelectionApplyOptions,
) => Promise<boolean>;

export function createModelSelectionRequestId(): string {
  return crypto.randomUUID();
}

export function isCurrentModelSelectionIntent(
  sessionId: string,
  requestId: string,
): boolean {
  return (
    useChatSessionStore.getState().getModelSelectionIntent(sessionId)
      ?.requestId === requestId
  );
}

export function clearCurrentModelSelectionIntent(
  sessionId: string,
  requestId: string,
): boolean {
  if (!isCurrentModelSelectionIntent(sessionId, requestId)) {
    return false;
  }
  useChatSessionStore
    .getState()
    .clearModelSelectionIntent(sessionId, requestId);
  return true;
}

export function showModelSwitchErrorToast({
  modelName,
  fallbackModelName,
}: {
  modelName: string;
  fallbackModelName?: string | null;
}): void {
  toast.error(
    fallbackModelName
      ? i18n.t("chat:notifications.modelSwitchError", {
          model: modelName,
          fallbackModel: fallbackModelName,
        })
      : i18n.t("chat:notifications.modelSwitchErrorWithoutFallback", {
          model: modelName,
        }),
  );
}

export function rollbackToPreviousModel({
  sessionId,
  failedModelName,
  previous,
  applySessionModelSelection,
  prepareSelectedProvider,
  setGlobalSelectedProvider,
  options,
  restoreErrorMessage,
}: {
  sessionId: string;
  failedModelName: string;
  previous: PreviousModelSelection;
  applySessionModelSelection: ApplySessionModelSelection;
  prepareSelectedProvider: PrepareSelectedProvider;
  setGlobalSelectedProvider?: (providerId: string) => void;
  options?: ModelSelectionApplyOptions;
  restoreErrorMessage: string;
}): void {
  const { providerId, modelId, modelName } = previous;
  useChatSessionStore.getState().patchSession(sessionId, {
    providerId,
    modelId,
    modelName,
  });

  if (providerId) {
    setGlobalSelectedProvider?.(providerId);
  }

  showModelSwitchErrorToast({
    modelName: failedModelName,
    fallbackModelName: modelName ?? null,
  });

  if (providerId && modelId) {
    const rollbackRequestId = createModelSelectionRequestId();
    const rollbackSelection: PreferredModelSelection = {
      id: modelId,
      name: modelName ?? modelId,
      providerId,
      source: "explicit",
    };
    useChatSessionStore.getState().beginModelSelectionIntent(sessionId, {
      requestId: rollbackRequestId,
      kind: "model",
      providerId,
      modelId,
      modelName: modelName ?? modelId,
    });
    void applySessionModelSelection(
      providerId,
      rollbackSelection,
      rollbackRequestId,
      options,
    )
      .catch((rollbackError) => {
        console.error(restoreErrorMessage, rollbackError);
      })
      .finally(() => {
        clearCurrentModelSelectionIntent(sessionId, rollbackRequestId);
      });
    return;
  }

  if (providerId) {
    void prepareSelectedProvider(providerId, options).catch((rollbackError) => {
      console.error(restoreErrorMessage, rollbackError);
    });
  }
}
