import type { ReactNode, RefObject } from "react";
import type { AcpProvider } from "@/shared/api/acp";
import type { AgentProviderReadiness } from "@/features/providers/hooks/useAgentProviderStatus";
import type { BerdChatChatSourceSurface } from "@/shared/telemetry/events";
import type { Persona } from "@/shared/types/agents";
import type {
  ChatAttachmentDraft,
  MessageChip,
  MessageMetadata,
} from "@/shared/types/messages";
import type { ChatSessionReasoningEffortConfig } from "./stores/chatSessionStore";
import type { QueuedMessagePayload } from "./stores/chatStore";
import type { SessionExecutionTarget } from "./lib/sessionExecutionTarget";

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
  instructions?: string;
  fileLocation?: string;
}

export interface ChatSendOptions {
  /** Internal target snapshot owned by the active queued dispatch attempt. */
  sessionSelection?: SessionExecutionTarget;
  /** Coordinator token proving ownership of sessionSelection. */
  sessionSelectionToken?: symbol;
  systemPrompt?: string;
  /** Internal queue ownership check at the transcript commit boundary. */
  beforeUserMessageCommitted?: () => void;
  /** Internal notification that this attempt has committed its user turn. */
  onUserMessageCommitted?: () => void;
  /** Fully composed execution prompt captured for a queued send. */
  executionSystemPrompt?: string;
  /**
   * Composer surface that accepted this send, captured for `berd_chat` send
   * telemetry. A queued record can outlive the surface that accepted it — a
   * deferred-workspace first send is released to the background queued-send
   * pipeline, which cannot recompute the surface — so it rides with the
   * payload. berdctl/background-origin payloads never set it; their sends
   * stay untracked by design.
   */
  telemetrySourceSurface?: BerdChatChatSourceSurface;
  /** Persona-only prompt captured while workspace context is still loading. */
  capturedPersonaSystemPrompt?: string;
  displayText?: string;
  assistantPrompt?: string;
  chips?: MessageChip[];
  userMessageMetadata?: Partial<MessageMetadata>;
  acpGooseMetadata?: Record<string, unknown>;
}

export type ChatInputSendHandler = (
  text: string,
  personaId?: string | null,
  attachments?: ChatAttachmentDraft[],
  options?: ChatSendOptions,
) => boolean | Promise<boolean>;

export interface ChatInputVoiceConversation {
  visible: boolean;
  state:
    | "off"
    | "starting"
    | "stopping"
    | "listening"
    | "user-speaking"
    | "agent-working"
    | "agent-speaking"
    | "error";
  boundSessionId: string | null;
  active: boolean;
  ownsActiveConversation?: boolean;
  microphoneMuted: boolean;
  error?: string | null;
  disabled?: boolean;
  onToggle: () => void | Promise<void>;
  onMicrophoneMuteToggle: () => void | Promise<void>;
}

export interface ChatInputComposerActions {
  onSend: ChatInputSendHandler;
  onSteerMessage?: ChatInputSendHandler;
  onStop?: () => void;
  onSteerQueuedMessage?: () => boolean | Promise<boolean>;
  canSteerMessage?: boolean;
  canSteerQueuedMessage?: boolean;
  isStreaming?: boolean;
  disabled?: boolean;
  sendDisabled?: boolean;
  sendDisabledReason?: string;
  queuedMessage?: QueuedMessagePayload | null;
  queuedMessages?: Array<{
    recordId: string;
    payload: QueuedMessagePayload;
  }>;
  onSendQueue?: () => boolean | Promise<boolean>;
  onDismissQueue?: (recordId?: string) => void;
  onUpdateQueue?: (recordId: string, payload: QueuedMessagePayload) => boolean;
  onEditQueue?: (recordId: string) => boolean;
  onCancelQueueEdit?: (recordId: string) => boolean;
  voiceConversation?: ChatInputVoiceConversation;
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
  currentExecutionTarget?: SessionExecutionTarget;
  availableModels?: ModelOption[];
  modelsLoading?: boolean;
  modelStatusMessage?: string | null;
  onModelChange?: (modelId: string, model?: ModelOption) => void;
  onPickerOpen?: () => void;
  /**
   * "gated" hides the agent column behind a "Switch agent" button, for
   * surfaces where changing agent can recreate an existing session.
   */
  providerColumnMode?: "visible" | "gated";
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

export interface ChatInputRemoteHostPicker {
  enabled?: boolean;
  selectedHost?: string | null;
  /** SSH host aliases to offer; defaults to the remote-host store's list. */
  hosts?: string[];
  onHostChange?: (host: string | null) => void;
  selectedDir?: string | null;
  onDirChange?: (dir: string | null) => void;
}

export interface ChatInputReasoningEffort {
  config?: ChatSessionReasoningEffortConfig;
  onChange?: (value: string) => void;
}

export interface ChatInputContextUsage {
  contextTokens?: number;
  contextLimit?: number;
  isContextUsageReady?: boolean;
  // Estimated session cost in USD from the engine; null when unavailable.
  accumulatedCost?: number | null;
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
  personaPicker?: boolean;
  projectPicker?: boolean;
  skills?: boolean;
  voice?: boolean;
}

export interface ChatInputProps {
  composerActions: ChatInputComposerActions;
  initialValue?: string;
  initialAttachments?: ChatAttachmentDraft[];
  placeholder?: string;
  onDraftChange?: (text: string) => void;
  /** Mirrors the live composer attachments so a remounted chat can restore them. */
  onDraftAttachmentsChange?: (attachments: ChatAttachmentDraft[]) => void;
  selectedSkills?: ChatSkillDraft[];
  onSkillsChange?: (skills: ChatSkillDraft[]) => void;
  skillProjectDirs?: string[];
  fileMentionProjectDirs?: string[];
  skillProviderId?: string | null;
  attachmentsEnabled?: boolean;
  className?: string;
  /** Renders after the queued-message pill and before the composer controls. */
  queuedMessageAccessory?: ReactNode;
  personaPicker?: ChatInputPersonaPicker;
  agentModelPicker?: ChatInputAgentModelPicker;
  reasoningEffort?: ChatInputReasoningEffort;
  projectPicker?: ChatInputProjectPicker;
  remoteHostPicker?: ChatInputRemoteHostPicker;
  contextUsage?: ChatInputContextUsage;
  controls?: ChatInputControls;
  /** Called when ↑ should recall the last sent user message. */
  onRecallLastUserMessage?: () => string | null;
  /** Optional larger surface that should accept attachment drops for this composer. */
  attachmentDropTargetRef?: RefObject<HTMLDivElement | null>;
  /** Mirrors attachment drag-over state when the drop target is rendered outside the composer. */
  onAttachmentDragOverChange?: (isDragOver: boolean) => void;
  /** Applies the docked chat surface to the inner shell, leaving queue chrome outside. */
  innerBareSurface?: boolean;
  /**
   * Visual surface for the composer.
   * - "pill" (default): translucent glass pill — used by the Home composer.
   * - "bare": no background of its own, so a parent panel provides the surface.
   *   The chat composer uses this to render a translucent glass floating island
   *   (the wrapper supplies --surface-composer + backdrop blur).
   */
  surface?: "pill" | "bare";
}
