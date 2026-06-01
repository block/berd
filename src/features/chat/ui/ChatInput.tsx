import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
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
  surface = "pill",
}: ChatInputProps) {
  const {
    onSend,
    onStop,
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
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    attachments,
    addBrowserFiles,
    addPathAttachments,
    removeAttachment,
    clearAttachments,
  } = useChatInputAttachments();
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const selectedSkillsRef = useRef(selectedSkills);
  selectedSkillsRef.current = visibleSelectedSkills;

  // Cap how tall the textarea grows before it scrolls internally. The chat
  // composer caps shorter so the floating island tops out ~260px tall (textarea
  // + ~76px of surrounding chrome) instead of growing unbounded; the Home pill
  // keeps the taller cap. Keep this in sync with the textarea's max-h-* class.
  const textareaMaxHeightPx = surface === "bare" ? 184 : 200;

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, textareaMaxHeightPx)}px`;
  }, [textareaMaxHeightPx]);

  const resetTextarea = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, []);

  useLayoutEffect(() => {
    resizeTextarea();
  });

  const hasQueuedMessage = queuedMessage !== null;

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

  const canSend =
    (text.trim().length > 0 ||
      (scopedControls.attachments && attachments.length > 0) ||
      visibleSelectedSkills.length > 0) &&
    !hasQueuedMessage &&
    !disabled &&
    !sendDisabled;

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

  const handleSend = useCallback(async () => {
    if (!canSend) {
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
    const submittedAttachments = scopedControls.attachments ? attachments : [];
    const accepted = await submitChatInputMessage(
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
  }, [
    attachments,
    canSend,
    clearAttachments,
    dictation,
    scopedControls.attachments,
    scopedControls.voice,
    setSelectedSkills,
    setText,
    submitChatInputMessage,
    text,
    visibleSelectedSkills,
  ]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (mentionOpen) {
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
      if (event.key === "Enter" || event.key === "Tab") {
        const item = confirmMention();
        if (item) {
          event.preventDefault();
          handleMentionConfirm(item);
          return;
        }
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

  useEffect(() => {
    if (!agentToolsTip) {
      setDismissedAgentToolsTipId(null);
    }
  }, [agentToolsTip]);

  const handleClearStickyPersona = useCallback(() => {
    onPersonaChange?.(null);
  }, [onPersonaChange]);

  const handleRemoveSkill = useCallback(
    (skillId: string) => {
      setSelectedSkills(selectedSkills.filter((skill) => skill.id !== skillId));
    },
    [selectedSkills, setSelectedSkills],
  );

  // Bare composer matches the conversation panel's chat radius so the two read
  // as one family; the floating Home pill keeps its softer composer radius.
  const composerRadius =
    surface === "bare" ? "rounded-card-chat" : "rounded-composer";

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
            <div className="max-w-[var(--chat-composer-max-width)]">
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
        <div className="mx-auto max-w-[var(--chat-composer-max-width)]">
          <Popover open={mentionOpen}>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone for file attachments */}
            <div
              ref={containerRef}
              className={cn(
                "relative px-5 pb-3 pt-4 transition-colors",
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
                <div className="mb-2 flex items-center gap-2 rounded-card-sm bg-muted px-3 py-1.5">
                  <span className="flex-1 truncate text-xs text-muted-foreground">
                    {t("queue.label", { text: queuedMessage.text })}
                  </span>
                  <button
                    type="button"
                    onClick={onDismissQueue}
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                    aria-label={t("queue.dismiss")}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              )}

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
                    // Backstop for the JS auto-resize cap (textareaMaxHeightPx).
                    surface === "bare" ? "max-h-[184px]" : "max-h-[200px]",
                    // The composer text scrolls with the cursor, but never shows
                    // its own scrollbar.
                    "scrollbar-none",
                  )}
                  aria-label={t("input.ariaLabel")}
                  data-testid="chat-composer"
                />
              </PopoverAnchor>

              <ChatInputToolbar
                personaPicker={{ selectedPersonaId }}
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
