import { ChatInput } from "@/features/chat/ui/ChatInput";
import {
  useChatSessionController,
  type WorkspaceNameRequest,
} from "@/features/chat/hooks/useChatSessionController";
import type { HomeScreenProps } from "./HomeScreen";
import { useTranslation } from "react-i18next";

interface HomeComposerProps {
  sessionId: string | null;
  onActivateSession: (sessionId: string) => void;
  onCreatePersona?: () => void;
  onWorkspaceNameRequest?: (request: WorkspaceNameRequest) => void;
  onCreateProject?: HomeScreenProps["onCreateProject"];
}

export function HomeComposer({
  sessionId,
  onActivateSession,
  onCreatePersona,
  onWorkspaceNameRequest,
  onCreateProject,
}: HomeComposerProps) {
  const { t } = useTranslation("chat");
  const controller = useChatSessionController({
    sessionId,
    isHomeSession: true,
    onMessageAccepted: onActivateSession,
    onCreatePersonaRequested: onCreatePersona,
    onWorkspaceNameRequest,
  });

  return (
    <ChatInput
      composerActions={{
        onSend: controller.handleSend,
        onSteerQueuedMessage: controller.steerQueuedMessage,
        canSteerQueuedMessage: controller.canSteerQueuedMessage,
        disabled: controller.projectMetadataPending,
        queuedMessage:
          controller.deferredWorkspaceRecord?.state.status === "naming"
            ? null
            : (controller.queue.queuedMessage ??
              controller.deferredWorkspaceRecord?.payload ??
              null),
        queuedMessageStatus:
          controller.deferredWorkspaceRecord?.state.status === "creating"
            ? t("queue.workspaceCreating")
            : controller.deferredWorkspaceRecord?.state.status === "failed" ||
                controller.deferredWorkspaceRecord?.state.status === "held"
              ? t("queue.workspaceFailed")
              : undefined,
        onSendQueue:
          controller.deferredWorkspaceRecord?.state.status === "failed" ||
          controller.deferredWorkspaceRecord?.state.status === "held"
            ? controller.sendDeferredAnyway
            : undefined,
        onDismissQueue:
          controller.deferredWorkspaceRecord?.state.status === "naming" ||
          controller.deferredWorkspaceRecord?.state.status === "creating"
            ? undefined
            : controller.queue.dismiss,
        onStop: controller.stopStreaming,
        isStreaming:
          controller.chatState === "streaming" ||
          controller.chatState === "thinking",
      }}
      initialValue={controller.draftValue}
      initialAttachments={controller.draftAttachments}
      onDraftChange={controller.handleDraftChange}
      onDraftAttachmentsChange={controller.handleDraftAttachmentsChange}
      selectedSkills={controller.selectedSkills}
      onSkillsChange={controller.handleSkillsChange}
      personaPicker={{
        personas: controller.personas,
        selectedPersonaId: controller.selectedPersonaId,
        onPersonaChange: controller.handlePersonaChange,
      }}
      agentModelPicker={{
        providers: controller.pickerAgents,
        providersLoading: controller.providersLoading,
        selectedProvider: controller.selectedProvider,
        onProviderChange: controller.handleProviderChange,
        currentModelId: controller.currentModelId,
        currentModelProviderId: controller.currentModelProviderId,
        currentModel: controller.currentModelName ?? undefined,
        availableModels: controller.availableModels,
        modelsLoading: controller.modelsLoading,
        modelStatusMessage: controller.modelStatusMessage,
        onModelChange: controller.handleModelChange,
        onPickerOpen: controller.handlePickerOpen,
      }}
      reasoningEffort={{
        config: controller.reasoningEffort,
        onChange: controller.handleReasoningEffortChange,
      }}
      projectPicker={{
        selectedProjectId: controller.selectedProjectId,
        availableProjects: controller.availableProjects,
        onProjectChange: controller.handleProjectChange,
        onCreateProject: (options) =>
          onCreateProject?.({
            onCreated: (projectId) => {
              controller.handleProjectChange(projectId);
              options?.onCreated?.(projectId);
            },
          }),
      }}
      contextUsage={{
        contextTokens: controller.tokenState.accumulatedTotal,
        contextLimit: controller.tokenState.contextLimit,
        accumulatedCost: controller.tokenState.accumulatedCost,
        isContextUsageReady: controller.isContextUsageReady,
      }}
    />
  );
}
