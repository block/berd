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
import { X } from "lucide-react";
import { IconCheck, IconCornerDownLeft } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  attachmentSnapshotsMatch,
  skillDraftSnapshotsMatch,
} from "../lib/chatInputSnapshots";
import {
  getChatInputAgentGroupLabel,
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
import { ASSISTIVE_UX_RULES } from "@/shared/assistive-ux/registry";
import {
  recordAssistiveMomentDismissed,
  recordAssistiveMomentRetired,
} from "@/shared/assistive-ux/runtime";
import { eventMatchesShortcutCommand } from "@/features/shortcuts/lib/shortcutRegistry";
import { cn } from "@/shared/lib/cn";
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
import type { ChatInputProps, ChatSkillDraft } from "../types";
import { ContextualTip } from "@/shared/ui/contextual-tip";
import {
  getStreamingShortcutAction,
  useStreamingShortcutPreference,
} from "../lib/streamingShortcutPreference";
import type { MessageChip } from "@/shared/types/messages";
import type { Persona } from "@/shared/types/agents";
import { useTextareaAutosize } from "@/shared/hooks/useTextareaAutosize";

const DOCKED_TEXTAREA_MIN_HEIGHT_PX = 140;
const DOCKED_TEXTAREA_MAX_HEIGHT_PX = 300;
const DOCKED_TEXTAREA_VIEWPORT_RATIO = 0.24;
const AGENT_TOOLS_TIP_AUTO_DISABLE_DISMISSALS = 3;
const AGENT_TOOLS_TIP_AUTO_DISMISS_MS = 4_500;
const AGENT_TOOLS_TIP_EXIT_ANIMATION_MS = 200;
const AGENT_TOOLS_CONNECTION_TIPS_MOMENT_ID =
  ASSISTIVE_UX_RULES.chatAgentToolsConnectionTips.id;

type AgentToolsTipResolutionMode = "latest" | "aggregate";

interface AgentToolsTipPresentation {
  message: string;
  actionLabel?: string;
  icon?: ReactNode;
  iconClassName?: string;
  onAction?: () => void;
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
  const openCompanyManagedConnections = () =>
    requestOpenSettings("connections", { connectionsTab: "companyManaged" });

  if (disconnectedTools.length > 0) {
    return {
      message: t("agentToolsTip.disconnected", {
        count: disconnectedTools.length,
        tools: formatAgentToolsList(disconnectedTools, locale),
      }),
      actionLabel: t("agentToolsTip.connect"),
      onAction: openCompanyManagedConnections,
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
  placeholder,
  onDraftChange,
  selectedSkills: selectedSkillsProp,
  onSkillsChange,
  fileMentionRoots,
  attachmentsEnabled = true,
  className,
  personaPicker,
  agentModelPicker,
  reasoningEffort,
  projectPicker,
  contextUsage,
  controls,
  onRecallLastUserMessage,
  attachmentDropTargetRef,
  onAttachmentDragOverChange,
  surface = "pill",
}: ChatInputProps) {
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
    onDismissQueue,
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
  const [internalSelectedSkills, setInternalSelectedSkills] = useState<
    ChatSkillDraft[]
  >([]);
  const [mentionedPersonas, setMentionedPersonas] = useState<Persona[]>([]);
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
  } = useChatInputAttachments();
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

  const hasQueuedMessage = queuedMessage !== null;
  const hasDraftContext =
    (scopedControls.attachments && attachments.length > 0) ||
    visibleSelectedSkills.length > 0;
  const hasComposedMessage = text.trim().length > 0 || hasDraftContext;
  const hasDraftContent = text.length > 0 || hasDraftContext;
  const canQueueMessage =
    hasComposedMessage &&
    !hasQueuedMessage &&
    !disabled &&
    !sendDisabled &&
    !attachmentWorkPending;
  const canSteerCurrentMessage =
    hasComposedMessage &&
    !hasQueuedMessage &&
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
  const effectiveFileMentionRoots =
    fileMentionRoots ?? selectedProject?.workingDirs;
  const stickyPersona = activePersona;
  const selectedPersonasForChips = useMemo(
    () =>
      mentionedPersonas.length > 0
        ? mentionedPersonas
        : stickyPersona
          ? [stickyPersona]
          : [],
    [mentionedPersonas, stickyPersona],
  );
  const selectedMessageChips = useMemo<MessageChip[]>(
    () =>
      selectedPersonasForChips.map((persona) => ({
        id: persona.id,
        label: persona.displayName,
        agentRole: persona.id === selectedPersonaId ? "active" : "mentioned",
        type: "agent",
      })),
    [selectedPersonaId, selectedPersonasForChips],
  );
  const selectedMessageChipsRef = useRef(selectedMessageChips);
  selectedMessageChipsRef.current = selectedMessageChips;

  // Reconcile mentioned personas inline when the active persona changes,
  // instead of in an effect, so the chips never render a stale selection for a
  // frame.
  const [previousSelectedPersonaId, setPreviousSelectedPersonaId] =
    useState(selectedPersonaId);
  if (previousSelectedPersonaId !== selectedPersonaId) {
    setPreviousSelectedPersonaId(selectedPersonaId);
    if (!selectedPersonaId) {
      setMentionedPersonas([]);
    } else {
      setMentionedPersonas((current) =>
        current.length > 0 &&
        !current.some((persona) => persona.id === selectedPersonaId)
          ? []
          : current,
      );
    }
  }

  const handlePersonaMentionAdded = useCallback((persona: Persona) => {
    setMentionedPersonas((current) => {
      if (current.some((selected) => selected.id === persona.id)) {
        return current;
      }
      return [...current, persona];
    });
  }, []);

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
    projectWorkingDirs: effectiveFileMentionRoots,
    skillsEnabled: scopedControls.skills,
    fileMentionsEnabled: scopedControls.fileMentions,
    text,
    setText,
    textareaRef,
    onPersonaChange,
    onPersonaMentionSelect: handlePersonaMentionAdded,
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
    onSend,
    setSelectedSkills,
    resolveSkillSlashCommand,
  });

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
    isSendLocked:
      hasQueuedMessage || disabled || sendDisabled || attachmentWorkPending,
  });

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
        ? attachments
        : [];
      const accepted = await submitChatInputMessage(
        submittedText,
        submittedAttachments,
        submittedSkills,
        submitHandler,
      );
      if (!accepted) {
        return;
      }
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
      attachments,
      clearAttachments,
      dictation,
      scopedControls.attachments,
      scopedControls.voice,
      setSelectedSkills,
      setText,
      submitChatInputMessage,
      text,
      visibleSelectedSkills,
    ],
  );

  const handleSend = useCallback(async () => {
    await submitCurrentMessage(onSend, canQueueMessage);
  }, [canQueueMessage, onSend, submitCurrentMessage]);

  const handleSteerCurrentMessage = useCallback(async () => {
    if (!onSteerMessage) {
      return;
    }

    await submitCurrentMessage(onSteerMessage, canSteerCurrentMessage);
  }, [canSteerCurrentMessage, onSteerMessage, submitCurrentMessage]);

  const handleSteerQueuedMessage = useCallback(() => {
    if (!onSteerQueuedMessage || !canSteerQueuedMessage) {
      return;
    }
    void onSteerQueuedMessage();
  }, [canSteerQueuedMessage, onSteerQueuedMessage]);

  const setTextWithCursorAtEnd = (value: string) => {
    setText(value);
    pendingCursorOffsetRef.current = value.length;
  };

  const restoreQueuedMessage = () => {
    if (!queuedMessage || !onDismissQueue) {
      return false;
    }

    const nextText =
      queuedMessage.sendOptions?.displayText ?? queuedMessage.text;
    setTextWithCursorAtEnd(nextText);
    onPersonaChange?.(queuedMessage.personaId ?? null);
    replaceAttachments(
      scopedControls.attachments ? (queuedMessage.attachments ?? []) : [],
    );
    setSelectedSkills([]);
    onDismissQueue();
    return true;
  };

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
          "chat.mention.completeDirectory",
        )
      ) {
        // Tab only completes when a mention confirms; otherwise it falls
        // through for native focus navigation.
        const item = confirmMention();
        if (item?.type === "file") {
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
      if (queuedMessage) {
        if (restoreQueuedMessage()) {
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
    if (eventMatchesShortcutCommand(event.nativeEvent, "chat.sendNow")) {
      event.preventDefault();
      if (isStreaming) {
        const action = getStreamingShortcutAction(
          streamingShortcutPreference.mode,
          event.metaKey || event.ctrlKey,
        );
        if (action === "steer") {
          if (canSteerCurrentMessage) {
            void handleSteerCurrentMessage();
            return;
          }
          if (hasQueuedMessage && !hasDraftContent && canSteerQueuedMessage) {
            handleSteerQueuedMessage();
            return;
          }
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
        if (
          !event.metaKey &&
          !event.ctrlKey &&
          hasQueuedMessage &&
          !hasDraftContent &&
          canSteerQueuedMessage
        ) {
          handleSteerQueuedMessage();
          return;
        }

        const action = getStreamingShortcutAction(
          streamingShortcutPreference.mode,
          event.metaKey,
        );
        if (action === "steer") {
          if (canSteerCurrentMessage) {
            void handleSteerCurrentMessage();
            return;
          }
          if (canSteerQueuedMessage) {
            handleSteerQueuedMessage();
            return;
          }
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
    isStreaming,
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
  const agentDisplayName = getChatInputAgentGroupLabel(
    selectedPersonasForChips.map((persona) => ({
      id: persona.id,
      displayName: persona.displayName,
    })),
    providerDisplayName,
    selectedPersonasForChips.length > 1 ? activePersona?.id : null,
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
    agentToolsTipsEnabled && agentToolsTips.length > 0;
  const [agentToolsConnectionsData, setAgentToolsConnectionsData] =
    useState<ListConnectionsResponse | null>(null);

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
    for (const connection of agentToolsConnectionsData?.connections ?? []) {
      map.set(connection.name, connection);
    }
    return map;
  }, [agentToolsConnectionsData?.connections]);
  const agentToolsStatuses = useMemo(() => {
    if (!agentToolsConnectionsData) return new Map<string, ConnectionStatus>();

    const map = new Map<string, ConnectionStatus>();
    for (const tip of agentToolsTips) {
      map.set(
        tip.id,
        resolveConnectionStatus(agentToolsConnectionsByName.get(tip.provider)),
      );
    }
    return map;
  }, [agentToolsConnectionsByName, agentToolsConnectionsData, agentToolsTips]);
  const disconnectedAgentToolsTips = agentToolsConnectionsData
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
  const agentToolsTipDismissId = agentToolsConnectionsData
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
    (personaId: string) => {
      setMentionedPersonas((current) => {
        if (current.length === 0) {
          onPersonaChange?.(null);
          return current;
        }

        const next = current.filter((persona) => persona.id !== personaId);
        if (personaId === selectedPersonaId) {
          onPersonaChange?.(next.at(-1)?.id ?? null);
        }
        return next;
      });
    },
    [onPersonaChange, selectedPersonaId],
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
    <TooltipProvider delayDuration={300}>
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
                surface === "bare" ? "px-4 pb-2.5 pt-3" : "px-5 pb-3 pt-4",
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
                personas={selectedPersonasForChips}
                activePersonaId={selectedPersonaId}
                skills={visibleSelectedSkills}
                onRemovePersona={handleRemovePersona}
                onRemoveSkill={handleRemoveSkill}
              />

              {queuedMessage && (
                <div className="mb-2 flex items-center gap-2 rounded-full bg-surface-chat-responding-pill-bg px-3 py-1.5 text-surface-chat-responding-pill-fg shadow-[var(--shadow-chat)]">
                  <span className="flex-1 truncate text-xs opacity-75">
                    {t("queue.label", { text: queuedMessage.text })}
                  </span>
                  {isStreaming && canSteerQueuedMessage ? (
                    <button
                      type="button"
                      onClick={handleSteerQueuedMessage}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-current opacity-75 hover:bg-surface-chat-responding-pill-fg/15 hover:opacity-100"
                      aria-label={t("toolbar.steer")}
                      title={t("toolbar.steerQueuedWithEnter")}
                    >
                      <IconCornerDownLeft
                        className="size-3"
                        aria-hidden="true"
                      />
                      {t("toolbar.steer")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={onDismissQueue}
                    className="shrink-0 rounded-full p-0.5 text-current opacity-75 hover:opacity-100"
                    aria-label={t("queue.dismiss")}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              )}

              <div
                id={mentionStatusId}
                role="status"
                aria-live="polite"
                className="sr-only"
              >
                {mentionStatusText}
              </div>
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
                    "mb-2 min-h-[36px] w-full resize-none overflow-x-hidden overflow-y-auto bg-transparent px-1 text-sm font-normal leading-relaxed text-foreground placeholder:text-placeholder-composer placeholder:opacity-100 focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 disabled:opacity-60",
                    // Backstop for the JS auto-resize cap.
                    surface === "bare"
                      ? "max-h-[clamp(140px,24dvh,300px)]"
                      : "max-h-[200px]",
                    "scrollbar-subtle overscroll-contain",
                  )}
                  aria-label={t("input.ariaLabel")}
                  aria-controls={mentionOpen ? mentionListboxId : undefined}
                  aria-describedby={mentionOpen ? mentionStatusId : undefined}
                  data-testid="chat-composer"
                />
              </PopoverAnchor>

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
                  voiceRecording: scopedControls.voice && dictation.isRecording,
                  voiceTranscribing:
                    scopedControls.voice && dictation.isTranscribing,
                  onVoiceToggle: scopedControls.voice
                    ? dictation.toggleRecording
                    : undefined,
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
