import { ChatInput } from "@/features/chat/ui/ChatInput";
import { useChatSessionController } from "@/features/chat/hooks/useChatSessionController";
import type { HomeScreenProps } from "./HomeScreen";

interface HomeComposerProps {
  sessionId: string | null;
  onActivateSession: (sessionId: string) => void;
  onCreatePersona?: () => void;
  onCreateProject?: HomeScreenProps["onCreateProject"];
}

export function HomeComposer({
  sessionId,
  onActivateSession,
  onCreatePersona,
  onCreateProject,
}: HomeComposerProps) {
  const controller = useChatSessionController({
    sessionId,
    isHomeSession: true,
    onMessageAccepted: onActivateSession,
    onCreatePersonaRequested: onCreatePersona,
  });

  return (
    <ChatInput
      composerActions={{
        onSend: controller.handleSend,
        onSteerQueuedMessage: controller.steerQueuedMessage,
        canSteerQueuedMessage: controller.canSteerQueuedMessage,
        disabled: controller.projectMetadataPending,
        queuedMessage: controller.queue.queuedMessage,
        onDismissQueue: controller.queue.dismiss,
        onStop: controller.stopStreaming,
        isStreaming:
          controller.chatState === "streaming" ||
          controller.chatState === "thinking",
      }}
      initialValue={controller.draftValue}
      onDraftChange={controller.handleDraftChange}
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
        isContextUsageReady: controller.isContextUsageReady,
      }}
    />
  );
}
