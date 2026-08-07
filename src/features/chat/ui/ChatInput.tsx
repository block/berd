import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useId,
  type ReactNode,
} from "react";
import { Pencil, X } from "lucide-react";
import { IconCheck, IconCornerDownLeft } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  attachmentSnapshotsMatch,
  skillDraftSnapshotsMatch,
} from "../lib/chatInputSnapshots";
import {
  draftAttachmentsEqual,
  makeRemountSafeDraftAttachments,
} from "../lib/draftAttachments";
import {
  getChatInputAgentLabel,
  getChatInputPlaceholder,
} from "../lib/chatInputPlaceholder";
import {
  type Connection,
  type ListConnectionsResponse,
  listConnections,
} from "@/features/connections/api/connections";
import {
  type ConnectionStatus,
  resolveConnectionStatus,
} from "@/features/connections/lib/connectionStatus";
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";
import { useProfileCapability } from "@/shared/profile/capabilities";
import { ASSISTIVE_UX_RULES } from "@/shared/assistive-ux/registry";
import {
  recordAssistiveMomentDismissed,
  recordAssistiveMomentRetired,
} from "@/shared/assistive-ux/runtime";
import {
  eventMatchesShortcutCommand,
  useShortcutBindings,
} from "@/features/shortcuts/lib/shortcutRegistry";
import { keyboardShortcutDisplayParts } from "@/shared/keyboard/keyboardShortcut";
import { cn } from "@/shared/lib/cn";
import { getPlatform } from "@/shared/lib/platform";
import { Badge } from "@/shared/ui/badge";
import { Popover, PopoverAnchor } from "@/shared/ui/popover";
import { MentionAutocomplete } from "./MentionAutocomplete";
import { useMentionHandlers } from "../hooks/useMentionHandlers";
import { ChatInputToolbar } from "./ChatInputToolbar";
import { formatProviderLabel } from "@/shared/ui/icons/ProviderIcons";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { useAttachmentDropTarget } from "../hooks/useAttachmentDropTarget";
import { useChatInputAttachments } from "../hooks/useChatInputAttachments";
import { useChatInputFilePicker } from "../hooks/useChatInputFilePicker";
import { ChatInputAttachments } from "./ChatInputAttachments";
import { ChatInputSelectionChips } from "./ChatInputSelectionChips";
import { useChatInputSubmit } from "../hooks/useChatInputSubmit";
import { useVoiceDictation } from "../hooks/useVoiceDictation";
import { resolveDisplayModelLabel } from "../lib/modelDisplayLabel";
import { resolveAgentToolsCapabilityTips } from "../lib/agentToolsCapabilities";
import { useAgentToolsTipsPreference } from "../lib/agentToolsTipPreferences";
import { getImageFilesFromClipboardItems } from "../lib/clipboardAttachments";
import { rejectsOversizedComposerPayload } from "../lib/submitComposerMessage";
import type { ChatInputProps, ChatSendOptions, ChatSkillDraft } from "../types";
import { ContextualTip } from "@/shared/ui/contextual-tip";
import {
  getStreamingShortcutAction,
  useStreamingShortcutPreference,
} from "../lib/streamingShortcutPreference";
import type { ChatAttachmentDraft, MessageChip } from "@/shared/types/messages";
import { useTextareaAutosize } from "@/shared/hooks/useTextareaAutosize";
import { useVoiceDictationShortcutTarget } from "../lib/voiceDictationShortcutController";

const DOCKED_TEXTAREA_MIN_HEIGHT_PX = 140;
const DOCKED_TEXTAREA_MAX_HEIGHT_PX = 300;
const DOCKED_TEXTAREA_VIEWPORT_RATIO = 0.24;
const AGENT_TOOLS_TIP_AUTO_DISABLE_DISMISSALS = 3;
const AGENT_TOOLS_TIP_AUTO_DISMISS_MS = 4_500;
const AGENT_TOOLS_TIP_EXIT_ANIMATION_MS = 200;
const AGENT_TOOLS_CONNECTION_TIPS_MOMENT_ID =
  ASSISTIVE_UX_RULES.chatAgentToolsConnectionTips.id;
const BERDCTL_CROSS_SESSION_ORIGIN = "berdctl_cross_session";

type AgentToolsTipResolutionMode = "latest" | "aggregate";

interface AgentToolsTipPresentation {
  message: string;
  actionLabel?: string;
  icon?: ReactNode;
  iconClassName?: string;
  onAction?: () => void;
}

function stripCrossSessionOrigin<T extends Record<string, unknown>>(
  metadata: T | undefined,
): T | undefined {
  if (metadata?.origin !== BERDCTL_CROSS_SESSION_ORIGIN) {
    return metadata;
  }

  const { origin: _origin, ...rest } = metadata;
  return Object.keys(rest).length > 0 ? (rest as T) : undefined;
}

function getManualEditQueuedSendOptions(
  sendOptions: ChatSendOptions | undefined,
): ChatSendOptions | null {
  if (!sendOptions) {
    return null;
  }

  const { userMessageMetadata, acpGooseMetadata, ...rest } = sendOptions;
  const nextUserMessageMetadata = stripCrossSessionOrigin(userMessageMetadata);
  const nextAcpGooseMetadata = stripCrossSessionOrigin(acpGooseMetadata);

  return {
    ...rest,
    ...(nextUserMessageMetadata
      ? { userMessageMetadata: nextUserMessageMetadata }
      : {}),
    ...(nextAcpGooseMetadata ? { acpGooseMetadata: nextAcpGooseMetadata } : {}),
  };
}

function refreshRestoredQueuedChips(
  sendOptions: ChatSendOptions,
  currentChips: MessageChip[],
): ChatSendOptions {
  const restoredNonAgentChips =
    sendOptions.chips?.filter((chip) => chip.type !== "agent") ?? [];
  const chips = [...currentChips, ...restoredNonAgentChips];
  const { chips: _chips, ...rest } = sendOptions;

  return chips.length > 0 ? { ...rest, chips } : rest;
}

function formatAgentToolsList(
  labels: string[],
  locale: string | undefined,
): string {
  return new Intl.ListFormat(locale, {
    style: "long",
    type: "conjunction",
  }).format(labels);
}

function getAgentToolsTipPresentation({
  disconnectedTools,
  locale,
  status,
  t,
  tool,
}: {
  disconnectedTools: string[];
  locale: string | undefined;
  status: ConnectionStatus | null;
  t: ReturnType<typeof useTranslation>["t"];
  tool: string | null;
}): AgentToolsTipPresentation | null {
  const openConnections = () => requestOpenSettings("connections");

  if (disconnectedTools.length > 0) {
    return {
      message: t("agentToolsTip.disconnected", {
        count: disconnectedTools.length,
        tools: formatAgentToolsList(disconnectedTools, locale),
      }),
      actionLabel: t("agentToolsTip.connect"),
      onAction: openConnections,
    };
  }

  if (status === null || tool === null) {
    return null;
  }

  return {
    message: t("agentToolsTip.connected", { tool }),
    icon: <IconCheck className="size-4" />,
    iconClassName: "bg-transparent text-success",
  };
}

export function ChatInput({
  composerActions,
  initialValue = "",
  initialAttachments,
  placeholder,
  onDraftChange,
  onDraftAttachmentsChange,
  selectedSkills: selectedSkillsProp,
  onSkillsChange,
  skillProjectDirs,
  fileMentionProjectDirs: fileMentionProjectDirsProp,
  skillProviderId,
  attachmentsEnabled = true,
  className,
  queuedMessageAccessory,
  personaPicker,
  agentModelPicker,
  reasoningEffort,
  projectPicker,
  contextUsage,
  controls,
  onRecallLastUserMessage,
  attachmentDropTargetRef,
  onAttachmentDragOverChange,
  innerBareSurface = false,
  surface = "pill",
}: ChatInputProps) {
  const voiceDictationBindings = useShortcutBindings(
    "chat.toggleVoiceDictation",
  );
  const voiceDictationShortcutDisplayParts = voiceDictationBindings[0]
    ? keyboardShortcutDisplayParts(
        voiceDictationBindings[0].shortcut,
        getPlatform() === "mac",
      )
    : undefined;
  const {
    onSend,
    onSteerMessage,
    onStop,
    onSteerQueuedMessage,
    canSteerMessage = false,
    canSteerQueuedMessage = false,
    isStreaming = false,
    disabled = false,
    sendDisabled = false,
    sendDisabledReason,
    queuedMessage = null,
    queuedMessages,
    onSendQueue,
    onDismissQueue,
    onUpdateQueue,
    onEditQueue,
    onCancelQueueEdit,
  } = composerActions;
  const {
    personas = [],
    selectedPersonaId = null,
    onPersonaChange,
  } = personaPicker ?? {};
  const {
    providers = [],
    providersLoading = false,
    selectedProvider = "goose",
    onProviderChange,
    currentModelId = null,
    currentModelProviderId = null,
    currentModel,
    availableModels = [],
    modelsLoading = false,
    modelStatusMessage = null,
    onModelChange,
    onPickerOpen,
    providerColumnMode,
  } = agentModelPicker ?? {};
  const {
    selectedProjectId = null,
    availableProjects = [],
    onProjectChange,
    onCreateProject,
  } = projectPicker ?? {};
  const {
    contextTokens = 0,
    contextLimit = 0,
    accumulatedCost = null,
    isContextUsageReady,
    onCompactContext,
    canCompactContext = false,
    isCompactingContext = false,
    supportsCompactionControls,
  } = contextUsage ?? {};
  const { i18n, t } = useTranslation("chat");
  const streamingShortcutPreference = useStreamingShortcutPreference();
  const scopedControls = {
    agentModelPicker: controls?.agentModelPicker ?? true,
    attachments: controls?.attachments ?? attachmentsEnabled,
    autoFocus: controls?.autoFocus ?? true,
    fileMentions: controls?.fileMentions ?? true,
    projectPicker: controls?.projectPicker ?? true,
    skills: controls?.skills ?? true,
    voice: controls?.voice ?? true,
  };
  const [text, setTextRaw] = useState(initialValue);
  const [editingQueuedRecordId, setEditingQueuedRecordId] = useState<
    string | null
  >(null);
  const editingQueuedRecordIdRef = useRef<string | null>(null);
  const onCancelQueueEditRef = useRef(onCancelQueueEdit);
  onCancelQueueEditRef.current = onCancelQueueEdit;
  useEffect(() => {
    return () => {
      const recordId = editingQueuedRecordIdRef.current;
      if (recordId) {
        onCancelQueueEditRef.current?.(recordId);
      }
    };
  }, []);
  const setEditingQueuedRecord = useCallback((recordId: string | null) => {
    editingQueuedRecordIdRef.current = recordId;
    setEditingQueuedRecordId(recordId);
  }, []);
  const [dismissedAgentToolsTipIds, setDismissedAgentToolsTipIds] = useState<
    Set<string>
  >(() => new Set());
  const [exitingAgentToolsTipId, setExitingAgentToolsTipId] = useState<
    string | null
  >(null);
  const [agentToolsTipResolutionMode, setAgentToolsTipResolutionMode] =
    useState<AgentToolsTipResolutionMode>("latest");
  const {
    enabled: agentToolsTipsEnabled,
    setEnabled: setAgentToolsTipsEnabled,
  } = useAgentToolsTipsPreference();
  const kgooseConnectionsEnabled = useProfileCapability("kgooseConnections");
  const [internalSelectedSkills, setInternalSelectedSkills] = useState<
    ChatSkillDraft[]
  >([]);
  const selectedSkills = selectedSkillsProp ?? internalSelectedSkills;
  const visibleSelectedSkills = scopedControls.skills ? selectedSkills : [];
  const setSelectedSkills = scopedControls.skills
    ? (onSkillsChange ?? setInternalSelectedSkills)
    : () => {};
  const textRef = useRef(initialValue);
  const pendingAggregateAgentToolsTipRef = useRef(false);
  const previousAgentToolsTipDismissIdRef = useRef<string | null>(null);
  useEffect(() => {
    setTextRaw(initialValue);
    textRef.current = initialValue;
  }, [initialValue]);
  const setText = useCallback(
    (
      value: string,
      tipResolutionMode: AgentToolsTipResolutionMode = "latest",
    ) => {
      setAgentToolsTipResolutionMode(tipResolutionMode);
      textRef.current = value;
      setTextRaw(value);
      onDraftChange?.(value);
    },
    [onDraftChange],
  );
  const [isCompact, setIsCompact] = useState(false);
  const [attachmentWorkCount, setAttachmentWorkCount] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCursorOffsetRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const effectiveAttachmentDropTargetRef =
    attachmentDropTargetRef ?? containerRef;
  const usesExternalAttachmentDropTarget = Boolean(attachmentDropTargetRef);
  const {
    attachments,
    addBrowserFiles,
    addPathAttachments,
    removeAttachment,
    replaceAttachments,
    clearAttachments,
  } = useChatInputAttachments(initialAttachments ?? []);
  const attachmentWorkPending = attachmentWorkCount > 0;
  const runAttachmentWork = useCallback(async (task: () => Promise<void>) => {
    setAttachmentWorkCount((count) => count + 1);
    try {
      await task();
    } finally {
      setAttachmentWorkCount((count) => Math.max(0, count - 1));
    }
  }, []);
  const addPathAttachmentsWithPending = useCallback(
    (paths: string[]) => runAttachmentWork(() => addPathAttachments(paths)),
    [addPathAttachments, runAttachmentWork],
  );
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const lastPersistedDraftAttachmentsRef = useRef<ChatAttachmentDraft[] | null>(
    null,
  );
  useEffect(() => {
    if (!onDraftAttachmentsChange) {
      return;
    }

    const nextDraftAttachments = makeRemountSafeDraftAttachments(attachments);
    if (nextDraftAttachments !== attachments) {
      attachmentsRef.current = nextDraftAttachments;
    }
    if (
      draftAttachmentsEqual(
        lastPersistedDraftAttachmentsRef.current ?? undefined,
        nextDraftAttachments,
      )
    ) {
      return;
    }

    lastPersistedDraftAttachmentsRef.current = nextDraftAttachments;
    onDraftAttachmentsChange(nextDraftAttachments);
  }, [attachments, onDraftAttachmentsChange]);
  const selectedSkillsRef = useRef(selectedSkills);
  selectedSkillsRef.current = visibleSelectedSkills;
  const handleFileMentionAttachmentSelect = useCallback(
    (file: { resolvedPath: string }) => {
      void addPathAttachmentsWithPending([file.resolvedPath]);
    },
    [addPathAttachmentsWithPending],
  );

  // Cap how tall the textarea grows before it scrolls internally. The docked
  // composer scales down on shorter windows so it doesn't crowd the transcript;
  // the Home pill keeps its fixed cap. Keep this in sync with the textarea's
  // max-h-* class.
  const getTextareaMaxHeightPx = useCallback(() => {
    if (surface !== "bare") {
      return 200;
    }

    if (typeof window === "undefined") {
      return DOCKED_TEXTAREA_MAX_HEIGHT_PX;
    }

    return Math.min(
      DOCKED_TEXTAREA_MAX_HEIGHT_PX,
      Math.max(
        DOCKED_TEXTAREA_MIN_HEIGHT_PX,
        Math.floor(window.innerHeight * DOCKED_TEXTAREA_VIEWPORT_RATIO),
      ),
    );
  }, [surface]);

  const {
    resetHeight: resetTextarea,
    scheduleAutosize: scheduleResizeTextarea,
  } = useTextareaAutosize({
    textareaRef,
    value: text,
    getMaxHeightPx: getTextareaMaxHeightPx,
    layoutKey: surface,
  });

  useLayoutEffect(() => {
    const cursorOffset = pendingCursorOffsetRef.current;
    if (cursorOffset === null) {
      return;
    }
    pendingCursorOffsetRef.current = null;
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.selectionStart = cursorOffset;
      textarea.selectionEnd = cursorOffset;
    }
  });

  useEffect(() => {
    if (surface !== "bare") {
      return;
    }

    window.addEventListener("resize", scheduleResizeTextarea);
    return () => {
      window.removeEventListener("resize", scheduleResizeTextarea);
    };
  }, [scheduleResizeTextarea, surface]);

  const visibleQueuedMessages = (
    queuedMessages ??
    (queuedMessage ? [{ recordId: "legacy", payload: queuedMessage }] : [])
  ).filter(({ payload }) => payload.showInComposer !== false);
  const hasDraftContext =
    (scopedControls.attachments && attachments.length > 0) ||
    visibleSelectedSkills.length > 0;
  const hasComposedMessage = text.trim().length > 0 || hasDraftContext;
  const hasDraftContent = text.length > 0 || hasDraftContext;
  const canQueueMessage =
    hasComposedMessage && !disabled && !sendDisabled && !attachmentWorkPending;
  const canSteerCurrentMessage =
    hasComposedMessage &&
    !disabled &&
    !sendDisabled &&
    !attachmentWorkPending &&
    isStreaming &&
    canSteerMessage &&
    Boolean(onSteerMessage);

  const activePersona = useMemo(
    () => personas.find((persona) => persona.id === selectedPersonaId) ?? null,
    [personas, selectedPersonaId],
  );
  const selectedProject = useMemo(
    () =>
      availableProjects.find((project) => project.id === selectedProjectId) ??
      null,
    [availableProjects, selectedProjectId],
  );
  const selectedProjectWorkingDirs = selectedProject?.workingDirs;
  const skillMentionProjectDirs =
    skillProjectDirs ?? selectedProjectWorkingDirs;
  const fileMentionProjectDirs =
    fileMentionProjectDirsProp ?? selectedProjectWorkingDirs;
  const selectedMessageChips = useMemo<MessageChip[]>(
    () =>
      activePersona
        ? [
            {
              id: activePersona.id,
              label: activePersona.displayName,
              agentRole: "active",
              type: "agent",
            },
          ]
        : [],
    [activePersona],
  );
  const selectedMessageChipsRef = useRef(selectedMessageChips);
  selectedMessageChipsRef.current = selectedMessageChips;

  const canSend = canQueueMessage;

  const handleSkillMentionAdded = useCallback(
    (skill: (typeof selectedSkills)[number]) => {
      if (
        selectedSkills.some((selectedSkill) => selectedSkill.id === skill.id)
      ) {
        return;
      }
      setSelectedSkills([...selectedSkills, skill]);
    },
    [selectedSkills, setSelectedSkills],
  );

  const {
    mentionOpen,
    atMentionCategory,
    mentionSelectedIndex,
    filteredPersonas,
    filteredSkills,
    filteredFiles,
    fileMentionsLoading,
    fileMentionsError,
    resolveSkillSlashCommand,
    detectMention,
    closeMention,
    navigateMention,
    setAtMentionCategory,
    handleMentionCategoryKey,
    confirmMention,
    handlePersonaMentionSelect,
    handleSkillMentionSelect,
    handleFileMentionSelect,
    handleMentionConfirm,
    skillMentionItems,
  } = useMentionHandlers({
    personas,
    skillProjectDirs: skillMentionProjectDirs,
    fileMentionProjectDirs,
    skillProviderId,
    skillsEnabled: scopedControls.skills,
    fileMentionsEnabled: scopedControls.fileMentions,
    text,
    setText,
    textareaRef,
    activePersonaId: selectedPersonaId,
    onPersonaChange,
    onSkillMentionSelect: handleSkillMentionAdded,
    onFileMentionSelect: scopedControls.attachments
      ? handleFileMentionAttachmentSelect
      : undefined,
  });
  const mentionListboxId = useId();
  const mentionStatusId = useId();
  const mentionOptionCount =
    filteredFiles.length + filteredPersonas.length + filteredSkills.length;
  const mentionStatusText = mentionOpen
    ? fileMentionsLoading
      ? t("mention.status.loadingPaths")
      : fileMentionsError
        ? t("mention.status.loadError")
        : mentionOptionCount > 0
          ? t("mention.status.referencesAvailable", {
              count: mentionOptionCount,
            })
          : t("mention.status.noMatches")
    : undefined;

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const nextIsCompact = entry.contentRect.width < 580;
        setIsCompact((current) =>
          current === nextIsCompact ? current : nextIsCompact,
        );
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (scopedControls.autoFocus) {
      textareaRef.current?.focus();
    }
  }, [scopedControls.autoFocus]);

  const { submitChatInputMessage, handleVoiceAutoSubmit } = useChatInputSubmit({
    attachmentsRef,
    selectedSkillsRef,
    selectedChipsRef: selectedMessageChipsRef,
    selectedPersonaId,
    skillProviderId,
    onSend,
    setSelectedSkills,
    resolveSkillSlashCommand,
  });
  const [restoredQueuedSendOptions, setRestoredQueuedSendOptions] =
    useState<ChatSendOptions | null>(null);

  const setTextFromDictation = useCallback(
    (value: string) => setText(value, "aggregate"),
    [setText],
  );

  const dictation = useVoiceDictation({
    text,
    setText: setTextFromDictation,
    attachments,
    clearAttachments,
    selectedPersonaId,
    onSend,
    onAutoSubmit: handleVoiceAutoSubmit,
    resetTextarea,
    isSendLocked: disabled || sendDisabled || attachmentWorkPending,
  });

  const handleVoiceDictationShortcut = useVoiceDictationShortcutTarget(
    textareaRef,
    {
      surface: "selected-chat",
      canStart: scopedControls.voice && dictation.isEnabled && !disabled,
      isRecording: scopedControls.voice && dictation.isRecording,
      toggle: dictation.toggleRecording,
    },
  );

  const submitRestoredQueuedMessage = useCallback(
    async (
      submittedText: string,
      submittedAttachments: typeof attachments,
      sendOptions: ChatSendOptions,
      submitHandler: typeof onSend,
    ) => {
      const displayText = submittedText.trim();
      const restoredSendOptions =
        sendOptions.displayText === undefined
          ? refreshRestoredQueuedChips(
              sendOptions,
              selectedMessageChipsRef.current,
            )
          : refreshRestoredQueuedChips(
              { ...sendOptions, displayText },
              selectedMessageChipsRef.current,
            );
      const sendResult = submitHandler(
        displayText || " ",
        selectedPersonaId ?? undefined,
        submittedAttachments.length > 0 ? submittedAttachments : undefined,
        restoredSendOptions,
      );
      const accepted = await Promise.resolve(sendResult);
      return accepted !== false;
    },
    [selectedPersonaId],
  );

  const submitCurrentMessage = useCallback(
    async (submitHandler: typeof onSend, canSubmitCurrentMessage: boolean) => {
      if (!canSubmitCurrentMessage) {
        return;
      }

      // Stop without flushing so Send uses the text already in the composer.
      // This also cancels an in-flight microphone startup.
      if (
        scopedControls.voice &&
        (dictation.isRecording ||
          dictation.isTranscribing ||
          dictation.isStarting())
      ) {
        dictation.stopRecording();
      }

      const submittedText = text;
      const submittedSkills = visibleSelectedSkills;
      const submittedAttachments = scopedControls.attachments
        ? attachmentsRef.current
        : [];
      const restoredSendOptions =
        restoredQueuedSendOptions && submittedSkills.length === 0
          ? restoredQueuedSendOptions
          : null;
      const accepted =
        editingQueuedRecordId && onUpdateQueue
          ? onUpdateQueue(editingQueuedRecordId, {
              text: submittedText.trim() || " ",
              personaId: selectedPersonaId ?? undefined,
              providerId: currentModelProviderId ?? selectedProvider,
              modelId: currentModelId ?? undefined,
              attachments:
                submittedAttachments.length > 0
                  ? submittedAttachments
                  : undefined,
              sendOptions: restoredSendOptions
                ? {
                    ...restoredSendOptions,
                    ...(restoredSendOptions.displayText === undefined
                      ? {}
                      : { displayText: submittedText.trim() }),
                  }
                : undefined,
            })
          : restoredSendOptions
            ? await submitRestoredQueuedMessage(
                submittedText,
                submittedAttachments,
                restoredSendOptions,
                submitHandler,
              )
            : await submitChatInputMessage(
                submittedText,
                submittedAttachments,
                submittedSkills,
                submitHandler,
              );
      if (!accepted) {
        return;
      }
      setRestoredQueuedSendOptions(null);
      setEditingQueuedRecord(null);
      const textStillMatchesSubmission = textRef.current === submittedText;
      const skillsStillMatchSubmission = skillDraftSnapshotsMatch(
        selectedSkillsRef.current,
        submittedSkills,
      );
      const attachmentsStillMatchSubmission = attachmentSnapshotsMatch(
        attachmentsRef.current,
        submittedAttachments,
      );
      if (textStillMatchesSubmission) {
        setText("");
      }
      if (skillsStillMatchSubmission) {
        setSelectedSkills([]);
      }
      if (attachmentsStillMatchSubmission) {
        clearAttachments();
      }
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    },
    [
      clearAttachments,
      currentModelId,
      currentModelProviderId,
      dictation,
      editingQueuedRecordId,
      onUpdateQueue,
      scopedControls.attachments,
      scopedControls.voice,
      setEditingQueuedRecord,
      setSelectedSkills,
      setText,
      restoredQueuedSendOptions,
      selectedPersonaId,
      selectedProvider,
      submitRestoredQueuedMessage,
      submitChatInputMessage,
      text,
      visibleSelectedSkills,
    ],
  );

  const handleSend = useCallback(async () => {
    await submitCurrentMessage(onSend, canQueueMessage);
  }, [canQueueMessage, onSend, submitCurrentMessage]);

  const handleSteerCurrentMessage = useCallback(() => {
    if (!onSteerMessage || !canSteerCurrentMessage) {
      return;
    }

    const submittedText = text;
    const submittedSkills = visibleSelectedSkills;
    const submittedAttachments = scopedControls.attachments
      ? attachmentsRef.current
      : [];

    // Steering stays fire-and-forget (the draft clears immediately, without
    // waiting for acknowledgement), so the payload budget must be checked
    // synchronously before anything is cleared: a rejected oversized draft
    // survives for the user to fix (BOT-1463).
    if (rejectsOversizedComposerPayload(submittedAttachments)) {
      return;
    }

    const restoredSendOptions =
      restoredQueuedSendOptions && submittedSkills.length === 0
        ? restoredQueuedSendOptions
        : null;

    if (
      scopedControls.voice &&
      (dictation.isRecording ||
        dictation.isTranscribing ||
        dictation.isStarting())
    ) {
      dictation.stopRecording();
    }

    if (restoredSendOptions) {
      void submitRestoredQueuedMessage(
        submittedText,
        submittedAttachments,
        restoredSendOptions,
        onSteerMessage,
      );
    } else {
      void submitChatInputMessage(
        submittedText,
        submittedAttachments,
        submittedSkills,
        onSteerMessage,
      );
    }

    if (editingQueuedRecordId) {
      onCancelQueueEdit?.(editingQueuedRecordId);
      setEditingQueuedRecord(null);
    }
    setRestoredQueuedSendOptions(null);
    setText("");
    setSelectedSkills([]);
    clearAttachments();
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [
    canSteerCurrentMessage,
    clearAttachments,
    dictation,
    editingQueuedRecordId,
    onCancelQueueEdit,
    onSteerMessage,
    restoredQueuedSendOptions,
    scopedControls.attachments,
    scopedControls.voice,
    setEditingQueuedRecord,
    setSelectedSkills,
    setText,
    submitChatInputMessage,
    submitRestoredQueuedMessage,
    text,
    visibleSelectedSkills,
  ]);

  const handleSteerQueuedMessage = useCallback(() => {
    if (!onSteerQueuedMessage || !canSteerQueuedMessage) {
      return;
    }
    void onSteerQueuedMessage();
  }, [canSteerQueuedMessage, onSteerQueuedMessage]);

  const setTextWithCursorAtEnd = useCallback(
    (value: string) => {
      setText(value);
      pendingCursorOffsetRef.current = value.length;
    },
    [setText],
  );

  const restoreQueuedMessage = useCallback(
    (recordId: string, message: NonNullable<typeof queuedMessage>) => {
      const isLegacyMessage = recordId === "legacy";
      if (isLegacyMessage ? !onDismissQueue : !onUpdateQueue) return false;
      if (!isLegacyMessage) {
        const previousRecordId = editingQueuedRecordIdRef.current;
        if (!onEditQueue?.(recordId)) return false;
        if (previousRecordId && previousRecordId !== recordId) {
          onCancelQueueEdit?.(previousRecordId);
        }
      }
      const nextText = message.sendOptions?.displayText ?? message.text;
      setTextWithCursorAtEnd(nextText);
      setRestoredQueuedSendOptions(
        getManualEditQueuedSendOptions(message.sendOptions),
      );
      setEditingQueuedRecord(isLegacyMessage ? null : recordId);
      onPersonaChange?.(message.personaId ?? null);
      replaceAttachments(
        scopedControls.attachments ? (message.attachments ?? []) : [],
      );
      setSelectedSkills([]);
      if (isLegacyMessage) onDismissQueue?.();
      return true;
    },
    [
      onDismissQueue,
      onEditQueue,
      onCancelQueueEdit,
      onPersonaChange,
      onUpdateQueue,
      replaceAttachments,
      scopedControls.attachments,
      setEditingQueuedRecord,
      setSelectedSkills,
      setTextWithCursorAtEnd,
    ],
  );

  const handleEditQueuedMessage = useCallback(
    (recordId: string, message: NonNullable<typeof queuedMessage>) => {
      if (restoreQueuedMessage(recordId, message)) textareaRef.current?.focus();
    },
    [restoreQueuedMessage],
  );

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const isComposing =
      event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
    if (!isComposing && handleMentionCategoryKey(event.nativeEvent)) {
      event.preventDefault();
      return;
    }
    if (mentionOpen && !isComposing) {
      if (
        eventMatchesShortcutCommand(event.nativeEvent, "chat.mention.close")
      ) {
        event.preventDefault();
        event.stopPropagation();
        closeMention();
        return;
      }
      if (eventMatchesShortcutCommand(event.nativeEvent, "chat.mention.next")) {
        event.preventDefault();
        navigateMention("down");
        return;
      }
      if (
        eventMatchesShortcutCommand(event.nativeEvent, "chat.mention.previous")
      ) {
        event.preventDefault();
        navigateMention("up");
        return;
      }
      if (event.key === "Enter") {
        // The open menu consumes Enter with any modifiers (the fixed
        // chat.mention.confirm command) so send/send-now never fire with a
        // half-typed mention in the composer.
        event.preventDefault();
        const item = confirmMention();
        if (item) {
          handleMentionConfirm(item);
        }
        return;
      }
      if (
        eventMatchesShortcutCommand(
          event.nativeEvent,
          "chat.mention.acceptSuggestion",
        )
      ) {
        // Tab accepts the highlighted suggestion (completing folder paths
        // in place instead of attaching); with nothing to accept it falls
        // through for native focus navigation.
        const item = confirmMention();
        if (item) {
          event.preventDefault();
          handleMentionConfirm(item, { completeDirectories: true });
          return;
        }
      }
    }
    if (
      !isComposing &&
      !hasDraftContent &&
      eventMatchesShortcutCommand(event.nativeEvent, "chat.recallLastMessage")
    ) {
      if (visibleQueuedMessages[0]) {
        if (
          restoreQueuedMessage(
            visibleQueuedMessages[0].recordId,
            visibleQueuedMessages[0].payload,
          )
        ) {
          event.preventDefault();
        }
        return;
      }

      // Recall (↑ by default) in an empty composer restores the most recent
      // sent message (single level).
      const recalled = onRecallLastUserMessage?.() ?? null;
      if (recalled !== null) {
        event.preventDefault();
        setTextWithCursorAtEnd(recalled);
        return;
      }
    }
    if (isComposing) {
      return;
    }
    if (handleVoiceDictationShortcut(event.nativeEvent)) {
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape" && isStreaming && onStop) {
      event.preventDefault();
      event.stopPropagation();
      onStop();
      return;
    }
    if (eventMatchesShortcutCommand(event.nativeEvent, "chat.sendNow")) {
      event.preventDefault();
      if (isStreaming) {
        const action = getStreamingShortcutAction(
          streamingShortcutPreference.mode,
          event.metaKey || event.ctrlKey,
        );
        if (action === "steer" && canSteerCurrentMessage) {
          void handleSteerCurrentMessage();
          return;
        }
      }
      void handleSend();
      return;
    }
    if (eventMatchesShortcutCommand(event.nativeEvent, "chat.insertNewline")) {
      if (
        event.key === "Enter" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        // Plain/Shift+Enter inserts the newline natively, preserving undo.
        return;
      }
      // Rebound to a combo the textarea won't handle natively: insert the
      // newline through the controlled state, keeping the caret after it.
      event.preventDefault();
      const textarea = textareaRef.current;
      const selectionStart = textarea?.selectionStart ?? text.length;
      const selectionEnd = textarea?.selectionEnd ?? text.length;
      setText(`${text.slice(0, selectionStart)}\n${text.slice(selectionEnd)}`);
      pendingCursorOffsetRef.current = selectionStart + 1;
      return;
    }
    if (eventMatchesShortcutCommand(event.nativeEvent, "chat.sendMessage")) {
      event.preventDefault();
      if (isStreaming) {
        const action = getStreamingShortcutAction(
          streamingShortcutPreference.mode,
          event.metaKey,
        );
        if (action === "steer" && canSteerCurrentMessage) {
          void handleSteerCurrentMessage();
          return;
        }
      }

      void handleSend();
    }
  };

  const handleInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    const nativeInputEvent = event.nativeEvent as InputEvent;
    const insertedLength = Math.max(0, value.length - textRef.current.length);
    const insertedTextLength = nativeInputEvent.data?.length ?? insertedLength;
    const isBulkInput =
      pendingAggregateAgentToolsTipRef.current ||
      nativeInputEvent.inputType === "insertFromPaste" ||
      nativeInputEvent.inputType === "insertFromDrop" ||
      insertedTextLength > 1 ||
      insertedLength > 8;

    pendingAggregateAgentToolsTipRef.current = false;
    setText(value, isBulkInput ? "aggregate" : "latest");
    const cursorPosition = event.target.selectionStart ?? value.length;
    detectMention(value, cursorPosition);
  };

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const pastedText = event.clipboardData.getData?.("text") ?? "";
      pendingAggregateAgentToolsTipRef.current = pastedText.length > 0;

      if (!scopedControls.attachments) {
        return;
      }
      const files = getImageFilesFromClipboardItems(event.clipboardData.items);

      if (files.length === 0) {
        return;
      }

      pendingAggregateAgentToolsTipRef.current = false;
      event.preventDefault();
      void runAttachmentWork(() => addBrowserFiles(files));
    },
    [addBrowserFiles, runAttachmentWork, scopedControls.attachments],
  );

  const {
    isAttachmentDragOver,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useAttachmentDropTarget({
    disabled: disabled || !scopedControls.attachments,
    targetRef: effectiveAttachmentDropTargetRef,
    bindTargetEvents: usesExternalAttachmentDropTarget,
    onDropFiles: (files) => {
      void runAttachmentWork(() => addBrowserFiles(files));
    },
    onDropPaths: (paths) => {
      void addPathAttachmentsWithPending(paths);
    },
  });
  const { handleAttachFiles, handleAttachFolders } = useChatInputFilePicker({
    disabled: disabled || !scopedControls.attachments,
    addPathAttachments: addPathAttachmentsWithPending,
  });

  useEffect(() => {
    onAttachmentDragOverChange?.(isAttachmentDragOver);
  }, [isAttachmentDragOver, onAttachmentDragOverChange]);

  useEffect(() => {
    return () => {
      onAttachmentDragOverChange?.(false);
    };
  }, [onAttachmentDragOverChange]);

  const providerDisplayName =
    providers.find((provider) => provider.id === selectedProvider)?.label ??
    formatProviderLabel(selectedProvider);
  const agentDisplayName = getChatInputAgentLabel(
    activePersona?.displayName,
    providerDisplayName,
  );
  const resolvedCurrentModel = useMemo(() => {
    return (
      resolveDisplayModelLabel({
        currentModelId,
        currentModelName: currentModel,
        currentModelProviderId,
        availableModels,
      }) ?? undefined
    );
  }, [availableModels, currentModel, currentModelId, currentModelProviderId]);
  const inputPlaceholder = getChatInputPlaceholder(
    t,
    agentDisplayName,
    scopedControls.voice && dictation.isRecording,
    scopedControls.voice && dictation.isTranscribing,
    placeholder,
  );
  const agentToolsTips = useMemo(
    () =>
      scopedControls.skills
        ? resolveAgentToolsCapabilityTips(text, skillMentionItems)
        : [],
    [scopedControls.skills, skillMentionItems, text],
  );
  const latestAgentToolsTip = agentToolsTips.at(-1) ?? null;
  const shouldLoadAgentToolsConnectionStatus =
    agentToolsTipsEnabled &&
    kgooseConnectionsEnabled &&
    agentToolsTips.length > 0;
  const [agentToolsConnectionsData, setAgentToolsConnectionsData] =
    useState<ListConnectionsResponse | null>(null);
  const availableAgentToolsConnectionsData = kgooseConnectionsEnabled
    ? agentToolsConnectionsData
    : null;

  useEffect(() => {
    if (!shouldLoadAgentToolsConnectionStatus) {
      setAgentToolsConnectionsData(null);
      return;
    }

    let cancelled = false;

    async function refreshConnections() {
      try {
        const response = await listConnections();
        if (!cancelled) {
          setAgentToolsConnectionsData(response);
        }
      } catch (error) {
        console.warn("Failed to load Agent Tools connection status:", error);
        if (!cancelled) {
          setAgentToolsConnectionsData(null);
        }
      }
    }

    void refreshConnections();
    const intervalId = window.setInterval(refreshConnections, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [shouldLoadAgentToolsConnectionStatus]);

  const agentToolsConnectionsByName = useMemo(() => {
    const map = new Map<string, Connection>();
    const connections = availableAgentToolsConnectionsData?.connections ?? [];
    for (const connection of connections) {
      map.set(connection.name, connection);
    }
    return map;
  }, [availableAgentToolsConnectionsData?.connections]);
  const agentToolsStatuses = useMemo(() => {
    if (!availableAgentToolsConnectionsData) {
      return new Map<string, ConnectionStatus>();
    }

    const map = new Map<string, ConnectionStatus>();
    for (const tip of agentToolsTips) {
      map.set(
        tip.id,
        resolveConnectionStatus(agentToolsConnectionsByName.get(tip.provider)),
      );
    }
    return map;
  }, [
    agentToolsConnectionsByName,
    availableAgentToolsConnectionsData,
    agentToolsTips,
  ]);
  const disconnectedAgentToolsTips = availableAgentToolsConnectionsData
    ? agentToolsTips.filter((tip) => {
        const status = agentToolsStatuses.get(tip.id);
        return status?.kind === "disconnected" || status?.kind === "expired";
      })
    : [];
  const latestAgentToolsStatus = latestAgentToolsTip
    ? (agentToolsStatuses.get(latestAgentToolsTip.id) ?? null)
    : null;
  const latestDisconnectedAgentToolsTips =
    latestAgentToolsTip &&
    (latestAgentToolsStatus?.kind === "disconnected" ||
      latestAgentToolsStatus?.kind === "expired")
      ? [latestAgentToolsTip]
      : [];
  const presentedDisconnectedAgentToolsTips =
    agentToolsTipResolutionMode === "aggregate"
      ? disconnectedAgentToolsTips
      : latestDisconnectedAgentToolsTips;
  const presentedDisconnectedAgentToolsLabels =
    presentedDisconnectedAgentToolsTips.map((tip) => tip.label);
  const agentToolsTipDismissId = availableAgentToolsConnectionsData
    ? presentedDisconnectedAgentToolsTips.length > 0
      ? `disconnected:${presentedDisconnectedAgentToolsTips
          .map((tip) => tip.id)
          .join(",")}`
      : latestAgentToolsTip && latestAgentToolsStatus
        ? `${latestAgentToolsTip.id}:${latestAgentToolsStatus.kind}`
        : null
    : null;
  const agentToolsTipPresentation = getAgentToolsTipPresentation({
    disconnectedTools: presentedDisconnectedAgentToolsLabels,
    locale: i18n.resolvedLanguage ?? i18n.language,
    status: latestAgentToolsStatus,
    t,
    tool: latestAgentToolsTip?.label ?? null,
  });
  const showAgentToolsTip =
    agentToolsTipsEnabled &&
    !mentionOpen &&
    latestAgentToolsTip !== null &&
    (agentToolsTipDismissId === null ||
      !dismissedAgentToolsTipIds.has(agentToolsTipDismissId));
  const markAgentToolsTipDismissed = useCallback((tipId: string) => {
    setDismissedAgentToolsTipIds((current) => {
      if (current.has(tipId)) return current;
      const next = new Set(current);
      next.add(tipId);
      return next;
    });
  }, []);

  useEffect(() => {
    const previousTipId = previousAgentToolsTipDismissIdRef.current;
    if (
      previousTipId &&
      previousTipId !== agentToolsTipDismissId &&
      !previousTipId.startsWith("disconnected:")
    ) {
      markAgentToolsTipDismissed(previousTipId);
    }
    previousAgentToolsTipDismissIdRef.current = agentToolsTipDismissId;
  }, [agentToolsTipDismissId, markAgentToolsTipDismissed]);
  const shouldAutoDismissAgentToolsTip =
    presentedDisconnectedAgentToolsTips.length === 0 &&
    (latestAgentToolsStatus?.kind === "active" ||
      latestAgentToolsStatus?.kind === "expiring");
  const isAgentToolsTipExiting =
    exitingAgentToolsTipId !== null &&
    exitingAgentToolsTipId === agentToolsTipDismissId;

  useEffect(() => {
    if (
      !showAgentToolsTip ||
      !shouldAutoDismissAgentToolsTip ||
      !agentToolsTipDismissId
    ) {
      return;
    }

    const exitTimeoutId = window.setTimeout(() => {
      setExitingAgentToolsTipId(agentToolsTipDismissId);
    }, AGENT_TOOLS_TIP_AUTO_DISMISS_MS);
    const dismissTimeoutId = window.setTimeout(() => {
      markAgentToolsTipDismissed(agentToolsTipDismissId);
      setExitingAgentToolsTipId((current) =>
        current === agentToolsTipDismissId ? null : current,
      );
    }, AGENT_TOOLS_TIP_AUTO_DISMISS_MS + AGENT_TOOLS_TIP_EXIT_ANIMATION_MS);

    return () => {
      window.clearTimeout(exitTimeoutId);
      window.clearTimeout(dismissTimeoutId);
    };
  }, [
    agentToolsTipDismissId,
    markAgentToolsTipDismissed,
    shouldAutoDismissAgentToolsTip,
    showAgentToolsTip,
  ]);

  useEffect(() => {
    if (text.trim().length === 0 && dismissedAgentToolsTipIds.size > 0) {
      setDismissedAgentToolsTipIds(new Set());
    }
  }, [dismissedAgentToolsTipIds.size, text]);

  useEffect(() => {
    if (agentToolsTips.length === 0 && exitingAgentToolsTipId !== null) {
      setExitingAgentToolsTipId(null);
    }
  }, [agentToolsTips.length, exitingAgentToolsTipId]);

  const handleAgentToolsTipDismiss = () => {
    if (agentToolsTipDismissId) {
      markAgentToolsTipDismissed(agentToolsTipDismissId);
    }

    const dismissedCount = recordAssistiveMomentDismissed(
      AGENT_TOOLS_CONNECTION_TIPS_MOMENT_ID,
    );
    if (dismissedCount >= AGENT_TOOLS_TIP_AUTO_DISABLE_DISMISSALS) {
      setAgentToolsTipsEnabled(false);
      recordAssistiveMomentRetired(
        AGENT_TOOLS_CONNECTION_TIPS_MOMENT_ID,
        "autoApplied",
      );
    }
  };

  const handleRemovePersona = useCallback(
    (_personaId: string) => {
      onPersonaChange?.(null);
    },
    [onPersonaChange],
  );

  const handleRemoveSkill = useCallback(
    (skillId: string) => {
      setSelectedSkills(selectedSkills.filter((skill) => skill.id !== skillId));
    },
    [selectedSkills, setSelectedSkills],
  );

  // Bare composer nests inside the chat panel inset, so it uses the next inner
  // radius step; the floating Home pill keeps its softer composer radius.
  const composerRadius = surface === "bare" ? "rounded-sm" : "rounded-composer";

  return (
    <TooltipProvider>
      <div
        className={cn(
          "relative z-10",
          // The floating Home pill needs outer breathing room from the screen
          // edge; the bare chat composer is inset by its panel wrapper instead.
          surface === "pill" && "px-2 pb-3 pt-0 sm:px-4 sm:pb-6",
          className,
        )}
      >
        {showAgentToolsTip &&
        latestAgentToolsTip &&
        agentToolsTipPresentation ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-full z-20 flex justify-center px-2 pb-3 sm:px-4">
            <div
              className={cn(
                "flex justify-center",
                surface === "bare"
                  ? "w-full"
                  : "max-w-[var(--chat-composer-max-width)]",
              )}
            >
              <ContextualTip
                className="pointer-events-auto"
                actionLabel={agentToolsTipPresentation.actionLabel}
                dismissLabel={t("agentToolsTip.dismiss")}
                icon={agentToolsTipPresentation.icon}
                iconClassName={agentToolsTipPresentation.iconClassName}
                onAction={agentToolsTipPresentation.onAction}
                onDismiss={handleAgentToolsTipDismiss}
                state={isAgentToolsTipExiting ? "closed" : "open"}
              >
                {agentToolsTipPresentation.message}
              </ContextualTip>
            </div>
          </div>
        ) : null}
        <div
          className={cn(
            surface === "bare"
              ? "w-full"
              : "mx-auto max-w-[var(--chat-composer-max-width)]",
          )}
        >
          <Popover open={mentionOpen}>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone for file attachments */}
            <div
              ref={containerRef}
              className={cn(
                "relative transition-colors",
                "chat-composer-shell",
                surface === "bare"
                  ? cn(
                      "px-4 pb-2.5 pt-3",
                      innerBareSurface &&
                        "bg-surface-chat-composer [backdrop-filter:var(--backdrop-composer-glass)] [-webkit-backdrop-filter:var(--backdrop-composer-glass)]",
                    )
                  : "px-5 pb-3 pt-4",
                composerRadius,
                surface === "pill" && "bg-surface-composer backdrop-blur-md",
                isAttachmentDragOver &&
                  !usesExternalAttachmentDropTarget &&
                  "bg-surface-composer/60",
              )}
              onDragEnter={
                usesExternalAttachmentDropTarget ? undefined : handleDragEnter
              }
              onDragOver={
                usesExternalAttachmentDropTarget ? undefined : handleDragOver
              }
              onDragLeave={
                usesExternalAttachmentDropTarget ? undefined : handleDragLeave
              }
              onDrop={usesExternalAttachmentDropTarget ? undefined : handleDrop}
            >
              {isAttachmentDragOver && !usesExternalAttachmentDropTarget && (
                <div
                  className={cn(
                    "pointer-events-none absolute inset-0 z-10 flex items-center justify-center border border-dashed border-border/80 bg-card/60",
                    composerRadius,
                  )}
                >
                  <Badge variant="secondary" className="px-3 py-1 text-sm">
                    {t("attachments.dropToAttach")}
                  </Badge>
                </div>
              )}

              <MentionAutocomplete
                filteredPersonas={filteredPersonas}
                filteredSkills={filteredSkills}
                filteredFiles={filteredFiles}
                isOpen={mentionOpen}
                onSelectPersona={handlePersonaMentionSelect}
                onSelectSkill={handleSkillMentionSelect}
                onSelectFile={handleFileMentionSelect}
                onClose={closeMention}
                selectedIndex={mentionSelectedIndex}
                listboxId={mentionListboxId}
                atCategory={atMentionCategory}
                onAtCategoryChange={setAtMentionCategory}
                pathsLoading={fileMentionsLoading}
                pathsError={fileMentionsError}
              />

              <ChatInputAttachments
                attachments={scopedControls.attachments ? attachments : []}
                onRemove={removeAttachment}
              />

              <ChatInputSelectionChips
                persona={activePersona}
                skills={visibleSelectedSkills}
                onRemovePersona={handleRemovePersona}
                onRemoveSkill={handleRemoveSkill}
              />

              {visibleQueuedMessages.length > 0 && (
                <div className="mb-2 flex max-h-36 flex-col gap-1 overflow-y-auto">
                  {visibleQueuedMessages.map(({ recordId, payload }, index) => (
                    <div
                      key={recordId}
                      data-slot="queued-message"
                      className="flex items-center gap-2 rounded-full bg-surface-chat-responding-pill-bg px-3 py-1.5 text-surface-chat-responding-pill-fg shadow-[var(--shadow-chat)]"
                    >
                      <span className="flex-1 truncate text-xs opacity-75">
                        {payload.text}
                      </span>
                      {index === 0 &&
                      isStreaming &&
                      canSteerQueuedMessage &&
                      editingQueuedRecordId !== recordId ? (
                        <button
                          type="button"
                          onClick={handleSteerQueuedMessage}
                          className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-current opacity-75 hover:bg-surface-chat-responding-pill-fg/15 hover:opacity-100"
                          aria-label={t("toolbar.steer")}
                          title={t("toolbar.steerQueued")}
                        >
                          <IconCornerDownLeft
                            className="size-3"
                            aria-hidden="true"
                          />
                          {t("toolbar.steer")}
                        </button>
                      ) : null}
                      {index === 0 && onSendQueue ? (
                        <button
                          type="button"
                          onClick={() => void onSendQueue()}
                          className="shrink-0 rounded-full px-2 text-xs"
                        >
                          {t("toolbar.send")}
                        </button>
                      ) : null}
                      {(
                        recordId === "legacy"
                          ? Boolean(onDismissQueue)
                          : Boolean(onUpdateQueue)
                      ) ? (
                        <button
                          type="button"
                          onClick={() =>
                            handleEditQueuedMessage(recordId, payload)
                          }
                          className="shrink-0 rounded-full p-0.5 text-current opacity-75 hover:opacity-100"
                          aria-label={t("queue.edit")}
                          title={t("queue.edit")}
                        >
                          <Pencil className="size-3.5" aria-hidden="true" />
                        </button>
                      ) : null}
                      {onDismissQueue ? (
                        <button
                          type="button"
                          onClick={() => {
                            if (editingQueuedRecordIdRef.current === recordId) {
                              setEditingQueuedRecord(null);
                            }
                            onDismissQueue?.(
                              recordId === "legacy" ? undefined : recordId,
                            );
                          }}
                          className="shrink-0 rounded-full p-0.5 text-current opacity-75 hover:opacity-100"
                          aria-label={t("queue.dismiss")}
                        >
                          <X className="size-3.5" />
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}

              {visibleQueuedMessages.length > 0 && queuedMessageAccessory ? (
                <div
                  data-slot="queued-message-accessory"
                  className={cn(
                    "mb-3 overflow-hidden rounded-t-sm bg-surface-composer-action",
                    surface === "bare" ? "-mx-4" : "-mx-5",
                  )}
                >
                  {queuedMessageAccessory}
                </div>
              ) : (
                queuedMessageAccessory
              )}

              <div
                id={mentionStatusId}
                role="status"
                aria-live="polite"
                className="sr-only"
              >
                {mentionStatusText}
              </div>
              <div className="relative mb-2 min-h-[36px]">
                <PopoverAnchor asChild>
                  <textarea
                    ref={textareaRef}
                    value={text}
                    onChange={handleInput}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    placeholder={inputPlaceholder}
                    disabled={disabled}
                    rows={1}
                    className={cn(
                      "min-h-[36px] w-full resize-none overflow-x-hidden overflow-y-auto bg-transparent px-1 text-sm font-normal leading-relaxed text-foreground placeholder:text-placeholder-composer placeholder:opacity-100 focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 disabled:opacity-60",
                      // Backstop for the JS auto-resize cap.
                      surface === "bare"
                        ? "max-h-[clamp(140px,24dvh,300px)]"
                        : "max-h-[200px]",
                      "scrollbar-subtle overscroll-contain",
                    )}
                    aria-label={t("input.ariaLabel")}
                    aria-controls={mentionOpen ? mentionListboxId : undefined}
                    aria-describedby={mentionOpen ? mentionStatusId : undefined}
                    // Lets the global archive-session shortcut (default mod+e)
                    // fire while the composer is focused; other editable fields
                    // keep blocking it (see isArchiveShortcutBlockedTarget).
                    data-chat-composer=""
                    data-testid="chat-composer"
                  />
                </PopoverAnchor>
              </div>

              <ChatInputToolbar
                agentModelPicker={{
                  enabled: scopedControls.agentModelPicker,
                  providers,
                  providersLoading,
                  selectedProvider,
                  onProviderChange,
                  currentModelId,
                  currentModelProviderId,
                  currentModel: resolvedCurrentModel,
                  availableModels,
                  modelsLoading,
                  modelStatusMessage,
                  onModelChange,
                  onPickerOpen,
                  providerColumnMode,
                }}
                projectPicker={{
                  enabled:
                    scopedControls.projectPicker && projectPicker?.enabled,
                  selectedProjectId,
                  availableProjects,
                  onProjectChange,
                  onCreateProject,
                }}
                reasoningEffort={reasoningEffort}
                contextUsage={{
                  contextTokens,
                  contextLimit,
                  accumulatedCost,
                  isContextUsageReady,
                  onCompactContext,
                  canCompactContext,
                  isCompactingContext,
                  supportsCompactionControls,
                }}
                composerActions={{
                  canSend,
                  isStreaming,
                  attachmentsEnabled: scopedControls.attachments,
                  onAttachFiles: handleAttachFiles,
                  onAttachFolders: handleAttachFolders,
                  disabled,
                  sendDisabledReason,
                  onSend: handleSend,
                  onStop,
                  voiceEnabled: scopedControls.voice && dictation.isEnabled,
                  voiceStarting: scopedControls.voice && dictation.isStarting(),
                  voiceRecording: scopedControls.voice && dictation.isRecording,
                  voiceTranscribing:
                    scopedControls.voice && dictation.isTranscribing,
                  voiceShortcutDisplayParts: voiceDictationShortcutDisplayParts,
                  onVoiceToggle: scopedControls.voice
                    ? dictation.toggleRecording
                    : undefined,
                  voiceConversation: composerActions.voiceConversation,
                }}
                isCompact={isCompact}
              />
            </div>
          </Popover>
        </div>
      </div>
    </TooltipProvider>
  );
}
