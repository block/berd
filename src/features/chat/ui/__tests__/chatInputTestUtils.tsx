import { ChatInput as BaseChatInput } from "../ChatInput";
import type {
  ChatInputAgentModelPicker,
  ChatInputComposerActions,
  ChatInputContextUsage,
  ChatInputPersonaPicker,
  ChatInputProjectPicker,
  ChatInputProps,
  ChatInputSendHandler,
} from "../../types";

type ChatInputHarnessProps = Omit<
  ChatInputProps,
  | "composerActions"
  | "personaPicker"
  | "agentModelPicker"
  | "projectPicker"
  | "contextUsage"
> &
  Partial<ChatInputComposerActions> &
  ChatInputPersonaPicker &
  ChatInputAgentModelPicker &
  ChatInputProjectPicker &
  ChatInputContextUsage & {
    onSend: ChatInputSendHandler;
  };

export function ChatInput({
  onSend,
  onSteerMessage,
  onStop,
  onSteerQueuedMessage,
  canSteerMessage,
  canSteerQueuedMessage,
  isStreaming,
  disabled,
  sendDisabled,
  sendDisabledReason,
  queuedMessage,
  queuedMessages,
  onDismissQueue,
  onUpdateQueue,
  onEditQueue,
  onCancelQueueEdit,
  voiceConversation,
  personas,
  selectedPersonaId,
  onPersonaChange,
  providers,
  providersLoading,
  selectedProvider,
  onProviderChange,
  currentModelId,
  currentModelProviderId,
  currentModel,
  currentExecutionTarget,
  availableModels,
  modelsLoading,
  modelStatusMessage,
  onModelChange,
  onPickerOpen,
  enabled: projectPickerEnabled,
  selectedProjectId,
  availableProjects,
  onProjectChange,
  onCreateProject,
  contextTokens,
  contextLimit,
  isContextUsageReady,
  onCompactContext,
  canCompactContext,
  isCompactingContext,
  supportsCompactionControls,
  ...props
}: ChatInputHarnessProps) {
  return (
    <BaseChatInput
      {...props}
      composerActions={{
        onSend,
        onSteerMessage,
        onStop,
        onSteerQueuedMessage,
        canSteerMessage,
        canSteerQueuedMessage,
        isStreaming,
        disabled,
        sendDisabled,
        sendDisabledReason,
        queuedMessage,
        queuedMessages,
        onDismissQueue,
        onUpdateQueue,
        onEditQueue,
        onCancelQueueEdit,
        voiceConversation,
      }}
      personaPicker={{
        personas,
        selectedPersonaId,
        onPersonaChange,
      }}
      agentModelPicker={{
        providers,
        providersLoading,
        selectedProvider,
        onProviderChange,
        currentModelId,
        currentModelProviderId,
        currentModel,
        currentExecutionTarget,
        availableModels,
        modelsLoading,
        modelStatusMessage,
        onModelChange,
        onPickerOpen,
      }}
      projectPicker={{
        enabled: projectPickerEnabled,
        selectedProjectId,
        availableProjects,
        onProjectChange,
        onCreateProject,
      }}
      contextUsage={{
        contextTokens,
        contextLimit,
        isContextUsageReady,
        onCompactContext,
        canCompactContext,
        isCompactingContext,
        supportsCompactionControls,
      }}
    />
  );
}
