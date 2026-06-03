import type { AcpProvider } from "@/shared/api/acp";
import type { AgentProviderReadiness } from "@/features/providers/hooks/useAgentProviderStatus";
import type { Persona } from "@/shared/types/agents";
import type { ChatAttachmentDraft, MessageChip } from "@/shared/types/messages";

export interface ModelOption {
  id: string;
  name: string;
  displayName?: string;
  provider?: string;
  providerId?: string;
  providerName?: string;
  contextLimit?: number | null;
  /** Whether this model should appear in the compact recommended picker. */
  recommended?: boolean;
  /** Whether this model should show the primary recommendation marker. */
  featured?: boolean;
  /** Suggested display order for model picker rows. */
  sortOrder?: number;
}

export interface ProjectOption {
  id: string;
  name: string;
  workingDirs: string[];
  icon?: string | null;
  color?: string | null;
}

export interface ChatSkillDraft {
  id: string;
  name: string;
  description?: string;
  sourceLabel?: string;
}

export interface ChatSendOptions {
  displayText?: string;
  assistantPrompt?: string;
  chips?: MessageChip[];
}

export type ChatInputSendHandler = (
  text: string,
  personaId?: string,
  attachments?: ChatAttachmentDraft[],
  options?: ChatSendOptions,
) => boolean | Promise<boolean>;

export interface ChatInputComposerActions {
  onSend: ChatInputSendHandler;
  onStop?: () => void;
  onSendNow?: ChatInputSendHandler;
  onSendQueuedNow?: () => boolean | Promise<boolean>;
  isStreaming?: boolean;
  disabled?: boolean;
  sendDisabled?: boolean;
  sendDisabledReason?: string;
  queuedMessage?: { text: string } | null;
  onDismissQueue?: () => void;
}

export interface ChatInputPersonaPicker {
  personas?: Persona[];
  selectedPersonaId?: string | null;
  onPersonaChange?: (personaId: string | null) => void;
}

export type AgentPickerSetupAction = "install" | "connect";

export interface AgentPickerOption extends AcpProvider {
  readiness?: AgentProviderReadiness;
  setupAction?: AgentPickerSetupAction;
}

export interface ChatInputAgentModelPicker {
  providers?: AgentPickerOption[];
  providersLoading?: boolean;
  selectedProvider?: string;
  onProviderChange?: (providerId: string) => void;
  currentModelId?: string | null;
  currentModelProviderId?: string | null;
  currentModel?: string;
  availableModels?: ModelOption[];
  modelsLoading?: boolean;
  modelStatusMessage?: string | null;
  onModelChange?: (modelId: string, model?: ModelOption) => void;
  onPickerOpen?: () => void;
}

export interface ChatInputProjectPicker {
  enabled?: boolean;
  selectedProjectId?: string | null;
  availableProjects?: ProjectOption[];
  onProjectChange?: (projectId: string | null) => void;
  onCreateProject?: (options?: {
    onCreated?: (projectId: string) => void;
  }) => void;
}

export interface ChatInputContextUsage {
  contextTokens?: number;
  contextLimit?: number;
  isContextUsageReady?: boolean;
  onCompactContext?: () => Promise<unknown> | undefined;
  canCompactContext?: boolean;
  isCompactingContext?: boolean;
  supportsCompactionControls?: boolean;
}

export interface ChatInputControls {
  agentModelPicker?: boolean;
  attachments?: boolean;
  autoFocus?: boolean;
  fileMentions?: boolean;
  projectPicker?: boolean;
  skills?: boolean;
  voice?: boolean;
}

export interface ChatInputProps {
  composerActions: ChatInputComposerActions;
  initialValue?: string;
  placeholder?: string;
  onDraftChange?: (text: string) => void;
  selectedSkills?: ChatSkillDraft[];
  onSkillsChange?: (skills: ChatSkillDraft[]) => void;
  attachmentsEnabled?: boolean;
  className?: string;
  personaPicker?: ChatInputPersonaPicker;
  agentModelPicker?: ChatInputAgentModelPicker;
  projectPicker?: ChatInputProjectPicker;
  contextUsage?: ChatInputContextUsage;
  controls?: ChatInputControls;
  /**
   * Visual surface for the composer.
   * - "pill" (default): translucent glass pill — used by the Home composer.
   * - "bare": no background of its own, so a parent panel provides the surface.
   *   The chat composer uses this to render a translucent glass floating island
   *   (the wrapper supplies --surface-composer + backdrop blur).
   */
  surface?: "pill" | "bare";
}
