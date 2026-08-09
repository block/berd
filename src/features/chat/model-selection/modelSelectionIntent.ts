import { toast } from "sonner";
import type { ProjectInfo } from "@/features/projects/api/projects";
import {
  clearSessionTargetSelection,
  getSessionTargetSelection,
  recordSessionTargetSelection,
  replaceSessionTargetAfterDispatch,
} from "@/features/chat/lib/sessionTargetCoordinator";
import { useChatSessionStore } from "../stores/chatSessionStore";
import { i18n } from "@/shared/i18n";
import type { SessionExecutionTarget } from "@/features/chat/lib/sessionExecutionTarget";
import { gooseServeSelectionFromExecutionTarget } from "@/features/chat/lib/gooseServeExecutionTarget";

export type PreferredModelSelection = {
  id: string;
  name: string;
  modelProviderId: string;
  source: "default" | "explicit";
};

export interface ModelSelectionApplyOptions {
  nextProject?: ProjectInfo | null;
  nextWorkspacePath?: string | null;
  requestId?: string;
}

export type ApplySessionModelSelection = (
  modelProviderId: string,
  modelSelection: PreferredModelSelection,
  requestId: string,
  options?: ModelSelectionApplyOptions,
) => Promise<boolean>;

type PrepareSelectedProvider = (
  wireProviderId: string,
  options?: ModelSelectionApplyOptions,
) => Promise<boolean>;

export function createModelSelectionRequestId(): string {
  return crypto.randomUUID();
}

export interface ModelSelectionIntent {
  requestId: string;
  target: SessionExecutionTarget;
  previousTarget?: SessionExecutionTarget;
  preferenceAgentId?: string;
}

export function beginModelSelectionIntent(
  sessionId: string,
  intent: ModelSelectionIntent,
): void {
  recordSessionTargetSelection({
    sessionId,
    operationId: intent.requestId,
    target: intent.target,
    previousTarget: intent.previousTarget,
    preferenceAgentId: intent.preferenceAgentId,
  });
}

export function getModelSelectionIntent(
  sessionId: string,
): ModelSelectionIntent | undefined {
  const selection = getSessionTargetSelection(sessionId);
  return selection
    ? {
        requestId: selection.operationId,
        target: selection.target,
        previousTarget: selection.previousTarget,
        preferenceAgentId: selection.preferenceAgentId,
      }
    : undefined;
}

export function isCurrentModelSelectionIntent(
  sessionId: string,
  requestId: string,
): boolean {
  return getSessionTargetSelection(sessionId)?.operationId === requestId;
}

export function clearCurrentModelSelectionIntent(
  sessionId: string,
  requestId?: string,
): boolean {
  return clearSessionTargetSelection(sessionId, requestId);
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
  previousTarget,
  applySessionModelSelection,
  prepareSelectedProvider,
  setGlobalSelectedProvider,
  options,
  restoreErrorMessage,
}: {
  sessionId: string;
  failedModelName: string;
  previousTarget?: SessionExecutionTarget;
  applySessionModelSelection: ApplySessionModelSelection;
  prepareSelectedProvider: PrepareSelectedProvider;
  setGlobalSelectedProvider?: (providerId: string) => void;
  options?: ModelSelectionApplyOptions;
  restoreErrorMessage: string;
}): void {
  const sessionStore = useChatSessionStore.getState();
  const currentTarget = sessionStore.getSession(sessionId)?.executionTarget;
  const {
    providerId: wireProviderId,
    modelId,
    modelName,
  } = gooseServeSelectionFromExecutionTarget(previousTarget);

  if (previousTarget) {
    setGlobalSelectedProvider?.(previousTarget.harnessId);
  } else {
    replaceSessionTargetAfterDispatch(sessionId, undefined);
  }

  showModelSwitchErrorToast({
    modelName: failedModelName,
    fallbackModelName: modelName ?? null,
  });

  if (previousTarget && wireProviderId) {
    const rollbackRequestId = createModelSelectionRequestId();
    beginModelSelectionIntent(sessionId, {
      requestId: rollbackRequestId,
      target: previousTarget,
      previousTarget: currentTarget,
    });
    const rollback = modelId
      ? applySessionModelSelection(
          wireProviderId,
          {
            id: modelId,
            name: modelName ?? modelId,
            modelProviderId: wireProviderId,
            source: "explicit",
          },
          rollbackRequestId,
          options,
        )
      : prepareSelectedProvider(wireProviderId, {
          ...options,
          requestId: rollbackRequestId,
        });
    void rollback
      .catch((rollbackError) => {
        console.error(restoreErrorMessage, rollbackError);
      })
      .finally(() => {
        clearCurrentModelSelectionIntent(sessionId, rollbackRequestId);
      });
    return;
  }
}
