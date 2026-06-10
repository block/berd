import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useId,
} from "react";
import { X } from "lucide-react";
import { IconCheck } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  attachmentSnapshotsMatch,
  skillDraftSnapshotsMatch,
} from "../lib/chatInputSnapshots";
import {
  getChatInputAgentLabel,
  getChatInputPlaceholder,
} from "../lib/chatInputPlaceholder";
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
import { submitComposerMessage } from "../lib/submitComposerMessage";
import { useVoiceDictation } from "../hooks/useVoiceDictation";
import { resolveDisplayModelLabel } from "../lib/modelDisplayLabel";
import { resolveAgentToolsCapabilityTip } from "../lib/agentToolsCapabilities";
import { useAgentToolsTipsPreference } from "../lib/agentToolsTipPreferences";
import { getImageFilesFromClipboardItems } from "../lib/clipboardAttachments";
import { resolveGooseHelpSkill } from "../lib/gooseHelpSkill";
import type { ChatInputProps, ChatSkillDraft } from "../types";
import { ContextualTip } from "@/shared/ui/contextual-tip";

export function ChatInput({
  composerActions,
  initialValue = "",
  placeholder,
  onDraftChange,
  selectedSkills: selectedSkillsProp,
  onSkillsChange,
  attachmentsEnabled = true,
  className,
  personaPicker,
  agentModelPicker,
  projectPicker,
  contextUsage,
  controls,
  onRecallLastUserMessage,
  surface = "pill",
}: ChatInputProps) {
  const {
    onSend,
    onStop,
    onSendNow,
    onSendQueuedNow,
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
    isContextUsageReady,
    onCompactContext,
    canCompactContext = false,
    isCompactingContext = false,
    supportsCompactionControls,
  } = contextUsage ?? {};
  const { t } = useTranslation("chat");
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
  const [dismissedAgentToolsTipId, setDismissedAgentToolsTipId] = useState<
    string | null
  >(null);
  const agentToolsTipsPreference = useAgentToolsTipsPreference();
  const [internalSelectedSkills, setInternalSelectedSkills] = useState<
    ChatSkillDraft[]
  >([]);
  const selectedSkills = selectedSkillsProp ?? internalSelectedSkills;
  const visibleSelectedSkills = scopedControls.skills ? selectedSkills : [];
  const setSelectedSkills = scopedControls.skills
    ? (onSkillsChange ?? setInternalSelectedSkills)
    : () => {};
  const textRef = useRef(initialValue);
  useEffect(() => {
    setTextRaw(initialValue);
    textRef.current = initialValue;
  }, [initialValue]);
  const setText = useCallback(
    (value: string) => {
      textRef.current = value;
      setTextRaw(value);
      onDraftChange?.(value);
    },
    [onDraftChange],
  );
  const [isCompact, setIsCompact] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCursorOffsetRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    attachments,
    addBrowserFiles,
    addPathAttachments,
    removeAttachment,
    replaceAttachments,
    clearAttachments,
  } = useChatInputAttachments();
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const selectedSkillsRef = useRef(selectedSkills);
  selectedSkillsRef.current = visibleSelectedSkills;

  // Cap how tall the textarea grows before it scrolls internally. The docked
  // chat composer can consume most of the chat panel; the floating Home pill
  // stays compact. Keep this in sync with the textarea's max-h-* class.
  const getTextareaMaxHeightPx = useCallback(() => {
    if (surface !== "bare") {
      return 200;
    }

    if (typeof window === "undefined") {
      return 480;
    }

    return Math.max(184, window.innerHeight - 260);
  }, [surface]);

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, getTextareaMaxHeightPx())}px`;
  }, [getTextareaMaxHeightPx]);

  const resetTextarea = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, []);

  useLayoutEffect(() => {
    resizeTextarea();
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

    window.addEventListener("resize", resizeTextarea);
    return () => window.removeEventListener("resize", resizeTextarea);
  }, [resizeTextarea, surface]);

  const hasQueuedMessage = queuedMessage !== null;
  const canInterruptAndSendNow = isStreaming && Boolean(onSendNow);
  const hasDraftContext =
    (scopedControls.attachments && attachments.length > 0) ||
    visibleSelectedSkills.length > 0;
  const hasComposedMessage = text.trim().length > 0 || hasDraftContext;
  const hasDraftContent = text.length > 0 || hasDraftContext;
  const canQueueMessage =
    hasComposedMessage && !hasQueuedMessage && !disabled && !sendDisabled;
  const canSendNow =
    hasComposedMessage && canInterruptAndSendNow && !disabled && !sendDisabled;

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
  const stickyPersona = activePersona;

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
    confirmMention,
    handlePersonaMentionSelect,
    handleSkillMentionSelect,
    handleFileMentionSelect,
    handleMentionConfirm,
    skillMentionItems,
  } = useMentionHandlers({
    personas,
    projectWorkingDirs: selectedProject?.workingDirs,
    skillsEnabled: scopedControls.skills,
    fileMentionsEnabled: scopedControls.fileMentions,
    text,
    setText,
    textareaRef,
    onPersonaChange,
    onSkillMentionSelect: handleSkillMentionAdded,
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

  const resolveAutoSkill = useCallback(
    (message: string) =>
      scopedControls.skills
        ? resolveGooseHelpSkill(message, skillMentionItems)
        : null,
    [scopedControls.skills, skillMentionItems],
  );

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setIsCompact(entry.contentRect.width < 580);
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
    selectedPersonaId,
    onSend,
    setSelectedSkills,
    resolveSkillSlashCommand,
    resolveAutoSkill,
  });

  const dictation = useVoiceDictation({
    text,
    setText,
    attachments,
    clearAttachments,
    selectedPersonaId,
    onSend,
    onAutoSubmit: handleVoiceAutoSubmit,
    resetTextarea,
    isSendLocked: hasQueuedMessage || disabled || sendDisabled,
  });

  const handleSend = useCallback(
    async (options?: { sendNow?: boolean }) => {
      const shouldSendNow = options?.sendNow === true;
      if (shouldSendNow ? !canSendNow : !canQueueMessage) {
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
      const send = shouldSendNow ? onSendNow : undefined;
      const accepted = send
        ? await submitComposerMessage({
            text: submittedText,
            attachments: submittedAttachments,
            skills: submittedSkills,
            selectedPersonaId,
            onSend: send,
            resolveSkillSlashCommand,
            resolveAutoSkill,
          })
        : await submitChatInputMessage(
            submittedText,
            submittedAttachments,
            submittedSkills,
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
      canQueueMessage,
      canSendNow,
      clearAttachments,
      dictation,
      onSendNow,
      resolveAutoSkill,
      resolveSkillSlashCommand,
      scopedControls.attachments,
      scopedControls.voice,
      selectedPersonaId,
      setSelectedSkills,
      setText,
      submitChatInputMessage,
      text,
      visibleSelectedSkills,
    ],
  );

  const handleSendQueuedNow = useCallback(() => {
    if (!onSendQueuedNow) {
      return;
    }
    void onSendQueuedNow();
  }, [onSendQueuedNow]);

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
    if (mentionOpen && !isComposing) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMention();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        navigateMention(event.key === "ArrowDown" ? "down" : "up");
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const item = confirmMention();
        if (item) {
          handleMentionConfirm(item);
        }
        return;
      }
      if (
        event.key === "Tab" &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        const item = confirmMention();
        if (item) {
          event.preventDefault();
          handleMentionConfirm(item, { completeDirectories: true });
          return;
        }
      }
    }
    if (
      event.key === "ArrowUp" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      event.nativeEvent.keyCode !== 229 &&
      !hasDraftContent
    ) {
      if (queuedMessage) {
        if (restoreQueuedMessage()) {
          event.preventDefault();
        }
        return;
      }

      // ↑ in an empty composer recalls the most recent sent message (single level).
      const recalled = onRecallLastUserMessage?.() ?? null;
      if (recalled !== null) {
        event.preventDefault();
        setTextWithCursorAtEnd(recalled);
        return;
      }
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.nativeEvent.isComposing &&
      event.nativeEvent.keyCode !== 229
    ) {
      event.preventDefault();
      if ((event.metaKey || event.ctrlKey) && canInterruptAndSendNow) {
        void handleSend({ sendNow: true });
        return;
      }
      void handleSend();
    }
  };

  const handleInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setText(value);
    const cursorPosition = event.target.selectionStart ?? value.length;
    detectMention(value, cursorPosition);
    resizeTextarea();
  };

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!scopedControls.attachments) {
        return;
      }
      const files = getImageFilesFromClipboardItems(event.clipboardData.items);

      if (files.length === 0) {
        return;
      }

      event.preventDefault();
      void addBrowserFiles(files);
    },
    [addBrowserFiles, scopedControls.attachments],
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
    targetRef: containerRef,
    onDropFiles: (files) => {
      void addBrowserFiles(files);
    },
    onDropPaths: (paths) => {
      void addPathAttachments(paths);
    },
  });
  const { handleAttachFiles, handleAttachFolders } = useChatInputFilePicker({
    disabled: disabled || !scopedControls.attachments,
    addPathAttachments,
  });

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
  const agentToolsTip = useMemo(
    () =>
      scopedControls.skills
        ? resolveAgentToolsCapabilityTip(text, skillMentionItems)
        : null,
    [scopedControls.skills, skillMentionItems, text],
  );
  const showAgentToolsTip =
    agentToolsTipsPreference.enabled &&
    !mentionOpen &&
    agentToolsTip !== null &&
    dismissedAgentToolsTipId !== agentToolsTip.id;

  if (!agentToolsTip && dismissedAgentToolsTipId !== null) {
    setDismissedAgentToolsTipId(null);
  }

  const handleClearStickyPersona = useCallback(() => {
    onPersonaChange?.(null);
  }, [onPersonaChange]);

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
        {showAgentToolsTip && agentToolsTip ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-full z-20 flex justify-center px-2 pb-3 sm:px-4">
            <div
              className={cn(
                surface === "bare"
                  ? "w-full"
                  : "max-w-[var(--chat-composer-max-width)]",
              )}
            >
              <ContextualTip
                className="pointer-events-auto"
                actionLabel={t("agentToolsTip.turnOff")}
                dismissLabel={t("agentToolsTip.dismiss")}
                icon={<IconCheck className="size-4" />}
                iconClassName="bg-transparent text-success"
                onAction={() => agentToolsTipsPreference.setEnabled(false)}
                onDismiss={() => setDismissedAgentToolsTipId(agentToolsTip.id)}
              >
                {t("agentToolsTip.available", { tool: agentToolsTip.label })}
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
                surface === "bare" ? "px-4 pb-2.5 pt-3" : "px-5 pb-3 pt-4",
                composerRadius,
                surface === "pill" && "bg-surface-composer backdrop-blur-md",
                isAttachmentDragOver && "bg-surface-composer/60",
              )}
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {isAttachmentDragOver && (
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
                pathsLoading={fileMentionsLoading}
                pathsError={fileMentionsError}
              />

              <ChatInputAttachments
                attachments={scopedControls.attachments ? attachments : []}
                onRemove={removeAttachment}
              />

              <ChatInputSelectionChips
                persona={stickyPersona}
                skills={visibleSelectedSkills}
                onClearPersona={handleClearStickyPersona}
                onRemoveSkill={handleRemoveSkill}
              />

              {queuedMessage && (
                <div className="mb-2 flex items-center gap-2 rounded-full bg-surface-chat-responding-pill-bg px-3 py-1.5 text-surface-chat-responding-pill-fg shadow-[var(--shadow-chat)]">
                  <span className="flex-1 truncate text-xs opacity-75">
                    {t("queue.label", { text: queuedMessage.text })}
                  </span>
                  {isStreaming && onSendQueuedNow ? (
                    <button
                      type="button"
                      onClick={handleSendQueuedNow}
                      className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium text-current opacity-75 hover:bg-surface-chat-responding-pill-fg/15 hover:opacity-100"
                      aria-label={t("toolbar.sendNow")}
                      title={t("toolbar.sendNow")}
                    >
                      {t("toolbar.sendNow")}
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
                    "mb-3 min-h-[36px] w-full resize-none overflow-x-hidden overflow-y-auto bg-transparent px-1 text-sm font-normal leading-relaxed text-foreground placeholder:text-placeholder-composer focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 disabled:opacity-60",
                    // Backstop for the JS auto-resize cap.
                    surface === "bare"
                      ? "max-h-[calc(100dvh-16rem)]"
                      : "max-h-[200px]",
                    // The composer text scrolls with the cursor, but never shows
                    // its own scrollbar.
                    "scrollbar-none overscroll-contain",
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
                contextUsage={{
                  contextTokens,
                  contextLimit,
                  isContextUsageReady,
                  onCompactContext,
                  canCompactContext,
                  isCompactingContext,
                  supportsCompactionControls,
                }}
                composerActions={{
                  canSend,
                  isStreaming,
                  hasQueuedMessage,
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
