import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconMicrophone,
  IconPlus,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useProviderSelection } from "@/features/agents/hooks/useProviderSelection";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { selectPersonas } from "@/features/agents/stores/agentSelectors";
import { useAttachmentDropTarget } from "@/features/chat/hooks/useAttachmentDropTarget";
import { useChatInputAttachments } from "@/features/chat/hooks/useChatInputAttachments";
import { useChatInputFilePicker } from "@/features/chat/hooks/useChatInputFilePicker";
import { useAgentModelPickerState } from "@/features/chat/hooks/useAgentModelPickerState";
import { useMentionHandlers } from "@/features/chat/hooks/useMentionHandlers";
import { getImageFilesFromClipboardItems } from "@/features/chat/lib/clipboardAttachments";
import { buildSkillSendPayload } from "@/features/chat/lib/skillSendPayload";
import { ChatInputAttachments } from "@/features/chat/ui/ChatInputAttachments";
import { ChatInputSelectionChips } from "@/features/chat/ui/ChatInputSelectionChips";
import { MentionAutocomplete } from "@/features/chat/ui/MentionAutocomplete";
import { AgentModelPicker } from "@/features/chat/ui/AgentModelPicker";
import type { SkillMentionItem } from "@/features/chat/ui/mentionDetection";
import { useVoiceDictation } from "@/features/chat/hooks/useVoiceDictation";
import { getStoredModelPreference } from "@/features/chat/lib/modelPreferences";
import type {
  ChatSendOptions,
  ChatSkillDraft,
  ModelOption,
} from "@/features/chat/types";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { resolveAgentProviderCatalogIdStrict } from "@/features/providers/providerCatalog";
import { getClient } from "@/shared/api/acpConnection";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { formatProviderLabel } from "@/shared/ui/icons/ProviderIcons";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/shared/ui/popover";
import type { ChatAttachmentDraft } from "@/shared/types/messages";

export interface GlobalComposeOptions {
  providerId?: string;
  modelId?: string;
  modelName?: string;
  projectId?: string | null;
  attachments?: ChatAttachmentDraft[];
  personaId?: string | null;
  sendOptions?: ChatSendOptions;
}

interface GlobalComposerPillProps {
  focusRequest?: number;
  onSend: (text: string, options?: GlobalComposeOptions) => void;
  suggestedPersonaId?: string | null;
}

interface ModelSelection {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
}

const MODEL_ALIAS_IDS = new Set(["current", "default"]);

const TEXTAREA_MAX_HEIGHT_PX = 200;

function getModelName(model: ModelOption) {
  return model.displayName ?? model.name ?? model.id;
}

function isModelAlias(modelId?: string | null): boolean {
  return modelId != null && MODEL_ALIAS_IDS.has(modelId);
}

function modelOptionToSelection(
  model: ModelOption,
  fallbackProviderId: string,
): ModelSelection {
  const providerId = model.providerId ?? fallbackProviderId;
  return {
    providerId,
    providerName: model.providerName ?? formatProviderLabel(providerId),
    modelId: model.id,
    modelName: getModelName(model),
  };
}

function findMatchingModel(
  models: ModelOption[],
  modelId: string,
  providerId?: string | null,
) {
  return (
    models.find(
      (model) =>
        model.id === modelId &&
        (!providerId || !model.providerId || model.providerId === providerId),
    ) ?? null
  );
}

function getPreferredModel(
  models: ModelOption[],
  fallbackProviderId: string,
): ModelSelection | null {
  const model =
    models.find((candidate) => candidate.recommended) ??
    models.find((candidate) => !isModelAlias(candidate.id)) ??
    models[0];

  return model ? modelOptionToSelection(model, fallbackProviderId) : null;
}

export function GlobalComposerPill({
  focusRequest = 0,
  onSend,
  suggestedPersonaId = null,
}: GlobalComposerPillProps) {
  const { t } = useTranslation("chat");
  const { providers, providersLoading, selectedProvider, setSelectedProvider } =
    useProviderSelection();
  const projects = useProjectStore((state) => state.projects);
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [providerOverride, setProviderOverride] = useState<string | null>(null);
  const [modelOverride, setModelOverride] = useState<ModelSelection | null>(
    null,
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [gooseDefaultSelection, setGooseDefaultSelection] =
    useState<ModelSelection | null>(null);
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(
    null,
  );
  const [selectedSkills, setSelectedSkills] = useState<ChatSkillDraft[]>([]);
  const [attachmentWorkCount, setAttachmentWorkCount] = useState(0);
  const personas = useAgentStore(selectPersonas);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastFocusRequestRef = useRef(focusRequest);
  const routePersonaIdRef = useRef<string | null>(suggestedPersonaId);
  const personaSelectionSourceRef = useRef<"none" | "route" | "user">("none");
  const userTouchedRoutePersonaRef = useRef(false);

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
  }, []);

  useLayoutEffect(() => {
    resizeTextarea();
  });
  const {
    attachments,
    addBrowserFiles,
    addPathAttachments,
    removeAttachment,
    clearAttachments,
  } = useChatInputAttachments();
  const attachmentWorkPending = attachmentWorkCount > 0;

  const runAttachmentWork = useCallback((task: () => Promise<void>) => {
    setAttachmentWorkCount((count) => count + 1);
    void task().finally(() => {
      setAttachmentWorkCount((count) => Math.max(0, count - 1));
    });
  }, []);

  const handleSkillMentionSelected = useCallback((skill: SkillMentionItem) => {
    setSelectedSkills((current) =>
      current.some((selected) => selected.id === skill.id)
        ? current
        : [...current, skill],
    );
  }, []);

  const selectedPersona = useMemo(
    () => personas.find((persona) => persona.id === selectedPersonaId) ?? null,
    [personas, selectedPersonaId],
  );
  const hasSendableContent =
    text.trim().length > 0 ||
    attachments.length > 0 ||
    selectedSkills.length > 0;
  const hasDraftContent =
    hasSendableContent ||
    providerOverride !== null ||
    modelOverride !== null ||
    selectedProjectId !== null;
  const canSend = hasSendableContent && !attachmentWorkPending;

  useEffect(() => {
    if (routePersonaIdRef.current !== suggestedPersonaId) {
      routePersonaIdRef.current = suggestedPersonaId;
      userTouchedRoutePersonaRef.current = false;
    }

    if (!suggestedPersonaId) {
      if (personaSelectionSourceRef.current === "route" && !hasDraftContent) {
        setSelectedPersonaId(null);
        personaSelectionSourceRef.current = "none";
      }
      return;
    }

    if (
      !hasDraftContent &&
      !userTouchedRoutePersonaRef.current &&
      selectedPersonaId !== suggestedPersonaId
    ) {
      setSelectedPersonaId(suggestedPersonaId);
      personaSelectionSourceRef.current = "route";
    }
  }, [hasDraftContent, selectedPersonaId, suggestedPersonaId]);

  useEffect(() => {
    if (focusRequest <= lastFocusRequestRef.current) {
      lastFocusRequestRef.current = focusRequest;
      return;
    }
    lastFocusRequestRef.current = focusRequest;
    textareaRef.current?.focus();
  }, [focusRequest]);

  const handleRemoveSelectedSkill = useCallback((skillId: string) => {
    setSelectedSkills((current) =>
      current.filter((skill) => skill.id !== skillId),
    );
  }, []);

  const handlePersonaChange = useCallback((personaId: string | null) => {
    setSelectedPersonaId(personaId);
    personaSelectionSourceRef.current = personaId ? "user" : "none";
    userTouchedRoutePersonaRef.current = true;
  }, []);

  const placeholder = t("globalPill.placeholder");
  const selectedProviderForPicker = providerOverride ?? selectedProvider;
  const {
    selectedAgentId,
    pickerAgents,
    availableModels,
    modelsLoading,
    modelStatusMessage,
    handleProviderChange,
    handleModelChange,
    handlePickerOpen,
  } = useAgentModelPickerState({
    providers,
    selectedProvider: selectedProviderForPicker,
    onProviderSelected: (providerId) => {
      setProviderOverride(providerId);
      setModelOverride(null);
      setSelectedProvider(providerId);
    },
    onModelSelected: (model) => {
      const selection = modelOptionToSelection(
        model,
        selectedProviderForPicker,
      );
      setProviderOverride(selection.providerId);
      setModelOverride(selection);
      setSelectedProvider(selection.providerId);
    },
  });

  const concreteSelectedProviderId =
    resolveAgentProviderCatalogIdStrict(selectedProviderForPicker) == null
      ? selectedProviderForPicker
      : null;
  const defaultModelSelection = useMemo(() => {
    const storedPreference = getStoredModelPreference(selectedAgentId);
    if (storedPreference) {
      const matchingModel = findMatchingModel(
        availableModels,
        storedPreference.modelId,
        storedPreference.providerId,
      );
      const storedSelectionCompatible =
        !concreteSelectedProviderId ||
        storedPreference.providerId === concreteSelectedProviderId;

      if (matchingModel || storedSelectionCompatible) {
        const providerId =
          matchingModel?.providerId ??
          storedPreference.providerId ??
          selectedProviderForPicker;
        return {
          providerId,
          providerName:
            matchingModel?.providerName ?? formatProviderLabel(providerId),
          modelId: storedPreference.modelId,
          modelName:
            matchingModel != null
              ? getModelName(matchingModel)
              : storedPreference.modelName,
        };
      }
    }

    if (
      gooseDefaultSelection &&
      (!concreteSelectedProviderId ||
        gooseDefaultSelection.providerId === concreteSelectedProviderId)
    ) {
      const matchingDefault = findMatchingModel(
        availableModels,
        gooseDefaultSelection.modelId,
        gooseDefaultSelection.providerId,
      );
      return matchingDefault
        ? modelOptionToSelection(matchingDefault, selectedProviderForPicker)
        : gooseDefaultSelection;
    }

    const compatibleModels = concreteSelectedProviderId
      ? availableModels.filter(
          (model) =>
            !model.providerId ||
            model.providerId === concreteSelectedProviderId,
        )
      : availableModels;

    return getPreferredModel(compatibleModels, selectedProviderForPicker);
  }, [
    availableModels,
    concreteSelectedProviderId,
    gooseDefaultSelection,
    selectedAgentId,
    selectedProviderForPicker,
  ]);
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const effectiveModelSelection = modelOverride ?? defaultModelSelection;

  const {
    mentionOpen,
    mentionSelectedIndex,
    filteredPersonas,
    filteredSkills,
    filteredFiles,
    detectMention,
    closeMention,
    navigateMention,
    confirmMention,
    handleMentionConfirm,
  } = useMentionHandlers({
    personas,
    projectWorkingDirs: selectedProject?.workingDirs,
    skillsEnabled: true,
    fileMentionsEnabled: true,
    text,
    setText,
    textareaRef,
    onPersonaChange: handlePersonaChange,
    onSkillMentionSelect: handleSkillMentionSelected,
  });

  const submitCompose = useCallback(
    (draftText: string) => {
      const trimmed = draftText.trim();
      if (
        trimmed.length === 0 &&
        attachments.length === 0 &&
        selectedSkills.length === 0
      ) {
        return false;
      }

      const options: GlobalComposeOptions = {};
      if (attachments.length > 0) {
        options.attachments = attachments;
      }
      if (providerOverride) {
        options.providerId = providerOverride;
      }
      if (modelOverride) {
        options.providerId = modelOverride.providerId;
        options.modelId = modelOverride.modelId;
        options.modelName = modelOverride.modelName;
      }
      if (selectedProjectId) {
        options.projectId = selectedProjectId;
      }
      if (selectedPersonaId) {
        options.personaId = selectedPersonaId;
      }
      const { messageText, sendOptions } = buildSkillSendPayload(
        trimmed,
        selectedSkills,
        null,
      );
      if (sendOptions) {
        options.sendOptions = sendOptions;
      }

      if (Object.keys(options).length > 0) {
        onSend(messageText, options);
      } else {
        onSend(messageText);
      }
      setText("");
      clearAttachments();
      setProviderOverride(null);
      setModelOverride(null);
      setSelectedProjectId(null);
      setSelectedPersonaId(null);
      personaSelectionSourceRef.current = "none";
      userTouchedRoutePersonaRef.current = false;
      setSelectedSkills([]);
      return true;
    },
    [
      attachments,
      clearAttachments,
      modelOverride,
      onSend,
      providerOverride,
      selectedPersonaId,
      selectedProjectId,
      selectedSkills,
    ],
  );

  const dictation = useVoiceDictation({
    text,
    setText,
    attachments,
    clearAttachments,
    selectedPersonaId: null,
    onSend: (draftText) =>
      attachmentWorkPending ? false : submitCompose(draftText),
    resetTextarea: () => {},
    isSendLocked: attachmentWorkPending,
  });

  useEffect(() => {
    if (selectedAgentId !== "goose") {
      setGooseDefaultSelection(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const client = await getClient();
        const defaults = await client.goose.GooseUnstableDefaultsRead({});

        if (cancelled) {
          return;
        }

        const providerId = defaults.providerId ?? selectedProvider;
        const modelId = defaults.modelId ?? undefined;

        setGooseDefaultSelection(
          modelId
            ? {
                providerId,
                providerName: formatProviderLabel(providerId),
                modelId,
                modelName: modelId,
              }
            : null,
        );
      } catch {
        if (!cancelled) {
          setGooseDefaultSelection(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedAgentId, selectedProvider]);

  const expanded =
    focused ||
    modelPickerOpen ||
    projectPickerOpen ||
    dictation.isRecording ||
    dictation.isTranscribing ||
    text.trim().length > 0 ||
    attachments.length > 0 ||
    selectedPersona !== null ||
    selectedSkills.length > 0;

  const effectivePlaceholder = dictation.isRecording
    ? t("toolbar.voiceInputRecording")
    : dictation.isTranscribing
      ? t("toolbar.voiceInputTranscribing")
      : placeholder;

  const handleSend = useCallback(() => {
    if (!canSend) {
      return;
    }

    if (
      dictation.isRecording ||
      dictation.isTranscribing ||
      dictation.isStarting()
    ) {
      dictation.stopRecording();
    }

    submitCompose(text);
  }, [canSend, dictation, submitCompose, text]);

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = getImageFilesFromClipboardItems(event.clipboardData.items);
      if (files.length === 0) {
        return;
      }

      event.preventDefault();
      runAttachmentWork(() => addBrowserFiles(files));
    },
    [addBrowserFiles, runAttachmentWork],
  );

  const {
    isAttachmentDragOver,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useAttachmentDropTarget({
    disabled: false,
    isStreaming: false,
    targetRef: containerRef,
    onDropFiles: (files) => {
      runAttachmentWork(() => addBrowserFiles(files));
    },
    onDropPaths: (paths) => {
      runAttachmentWork(() => addPathAttachments(paths));
    },
  });
  const { handleAttachFiles } = useChatInputFilePicker({
    disabled: false,
    addPathAttachments,
  });

  const projectButtonLabel = selectedProject?.name ?? t("toolbar.noProject");

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={t("globalPill.ariaLabel")}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setFocused(false);
        }
      }}
      className="fixed bottom-3 right-3 z-40 isolate flex w-[482px] max-w-[calc(100vw-24px)] flex-col rounded-composer bg-surface-composer-glass px-4 py-3 ring-1 ring-inset ring-[var(--ring-composer-glass-inner)] outline outline-1 outline-[var(--outline-composer-glass-outer)]"
      style={{
        backdropFilter: "blur(24px) saturate(180%) brightness(1.05)",
        WebkitBackdropFilter: "blur(24px) saturate(180%) brightness(1.05)",
      }}
    >
      {isAttachmentDragOver ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-composer border border-dashed border-border/80 bg-card/60">
          <span className="rounded-md bg-secondary px-3 py-1 text-sm text-secondary-foreground">
            {t("attachments.dropToAttach")}
          </span>
        </div>
      ) : null}
      {(selectedPersona || selectedSkills.length > 0) && (
        <div className="px-2">
          <ChatInputSelectionChips
            persona={selectedPersona}
            skills={selectedSkills}
            onClearPersona={() => handlePersonaChange(null)}
            onRemoveSkill={handleRemoveSelectedSkill}
          />
        </div>
      )}
      {attachments.length > 0 ? (
        <div className="max-h-36 overflow-y-auto overscroll-contain px-2 pr-1">
          <ChatInputAttachments
            attachments={attachments}
            onRemove={removeAttachment}
          />
        </div>
      ) : null}

      <div className="flex items-center gap-3 px-2">
        <Popover open={mentionOpen}>
          <PopoverAnchor asChild>
            <textarea
              ref={textareaRef}
              value={text}
              rows={1}
              onChange={(event) => {
                const value = event.target.value;
                setText(value);
                const cursor = event.target.selectionStart ?? value.length;
                detectMention(value, cursor);
              }}
              onKeyDown={(event) => {
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
                  !event.nativeEvent.isComposing &&
                  event.nativeEvent.keyCode !== 229
                ) {
                  event.preventDefault();
                  handleSend();
                }
              }}
              onPaste={handlePaste}
              placeholder={effectivePlaceholder}
              className="focus-override min-h-10 max-h-[200px] flex-1 resize-none appearance-none overflow-y-auto scrollbar-none border-0 bg-transparent py-2.5 text-[16px] leading-[20px] text-foreground outline-none placeholder:text-foreground focus:outline-none focus:ring-0"
            />
          </PopoverAnchor>
          <MentionAutocomplete
            isOpen={mentionOpen}
            filteredPersonas={filteredPersonas}
            filteredSkills={filteredSkills}
            filteredFiles={filteredFiles}
            selectedIndex={mentionSelectedIndex}
            onClose={closeMention}
            onSelectPersona={(persona) =>
              handleMentionConfirm({ type: "persona", persona })
            }
            onSelectSkill={(skill) =>
              handleMentionConfirm({ type: "skill", skill })
            }
            onSelectFile={(file) =>
              handleMentionConfirm({ type: "file", file })
            }
          />
        </Popover>

        <div
          aria-hidden={expanded}
          className={cn(
            "flex shrink-0 items-center gap-2 overflow-hidden transition-[max-width,opacity,margin-left] duration-150 ease-out",
            expanded
              ? "pointer-events-none -ml-3 max-w-0 opacity-0"
              : "max-w-32 opacity-100",
          )}
        >
          <Button
            type="button"
            tabIndex={expanded ? -1 : 0}
            variant="composer-action"
            size="icon-pill-sm"
            aria-label={t("toolbar.voiceInput")}
            title={t("toolbar.voiceInput")}
          >
            <IconMicrophone aria-hidden="true" />
          </Button>
          <Button
            type="button"
            tabIndex={expanded ? -1 : 0}
            onClick={handleSend}
            disabled={!canSend}
            variant="composer-action"
            size="icon-pill-sm"
            className={cn(!canSend && "disabled:opacity-100")}
            aria-label={t("toolbar.sendMessage")}
          >
            <IconArrowUp aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div
        aria-hidden={!expanded}
        className={cn(
          "overflow-hidden transition-[max-height,opacity,padding-top] duration-200 ease-out",
          expanded ? "max-h-20 pt-2 opacity-100" : "max-h-0 pt-0 opacity-0",
        )}
      >
        <div className="flex items-center gap-2">
          <Button
            type="button"
            tabIndex={expanded ? 0 : -1}
            onClick={() => {
              runAttachmentWork(handleAttachFiles);
            }}
            variant="composer-action"
            size="icon-pill-sm"
            aria-label={t("attachments.chooseFilesDialogTitle")}
          >
            <IconPlus aria-hidden="true" />
          </Button>

          <AgentModelPicker
            agents={pickerAgents}
            selectedAgentId={selectedAgentId}
            onAgentChange={handleProviderChange}
            currentModelId={effectiveModelSelection?.modelId ?? null}
            currentModelProviderId={effectiveModelSelection?.providerId ?? null}
            currentModelName={effectiveModelSelection?.modelName ?? null}
            availableModels={availableModels}
            modelsLoading={modelsLoading}
            modelStatusMessage={modelStatusMessage}
            onModelChange={handleModelChange}
            onOpen={handlePickerOpen}
            onOpenChange={setModelPickerOpen}
            loading={providersLoading}
            isCompact
            triggerTabIndex={expanded ? 0 : -1}
          />

          <Popover open={projectPickerOpen} onOpenChange={setProjectPickerOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                tabIndex={expanded ? 0 : -1}
                className="flex h-8 min-w-0 items-center gap-1 rounded-full px-2 text-[14px] text-foreground hover:bg-accent"
                aria-label={t("toolbar.selectProject")}
              >
                <span className="max-w-[120px] truncate">
                  {projectButtonLabel}
                </span>
                <IconChevronDown className="size-3 shrink-0 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-[260px] p-2">
              <div className="space-y-0.5">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedProjectId(null);
                    setProjectPickerOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent",
                    selectedProjectId === null && "bg-accent",
                  )}
                >
                  <span>{t("toolbar.noProject")}</span>
                  {selectedProjectId === null ? (
                    <IconCheck className="ml-2 size-4 shrink-0 text-muted-foreground" />
                  ) : null}
                </button>
                {projects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => {
                      setSelectedProjectId(project.id);
                      setProjectPickerOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent",
                      selectedProjectId === project.id && "bg-accent",
                    )}
                  >
                    <span className="truncate">{project.name}</span>
                    {selectedProjectId === project.id ? (
                      <IconCheck className="ml-2 size-4 shrink-0 text-muted-foreground" />
                    ) : null}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>

          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              tabIndex={expanded ? 0 : -1}
              disabled={!dictation.isRecording && !dictation.isEnabled}
              onClick={dictation.toggleRecording}
              variant="composer-action"
              size="icon-pill-sm"
              className={cn(
                dictation.isRecording &&
                  "bg-destructive/12 text-destructive hover:bg-destructive/16 hover:text-destructive active:bg-destructive/16 active:text-destructive",
                dictation.isTranscribing && "animate-pulse",
                !dictation.isRecording &&
                  !dictation.isEnabled &&
                  "opacity-50 hover:bg-accent",
              )}
              aria-label={
                dictation.isRecording
                  ? t("toolbar.voiceInputRecording")
                  : t("toolbar.voiceInput")
              }
              aria-pressed={dictation.isRecording}
              title={
                !dictation.isEnabled
                  ? t("toolbar.voiceInputDisabled")
                  : dictation.isRecording
                    ? t("toolbar.voiceInputRecording")
                    : dictation.isTranscribing
                      ? t("toolbar.voiceInputTranscribing")
                      : t("toolbar.voiceInput")
              }
            >
              <IconMicrophone aria-hidden="true" />
            </Button>
            <Button
              type="button"
              tabIndex={expanded ? 0 : -1}
              onClick={handleSend}
              disabled={!canSend}
              variant="composer-action"
              size="icon-pill-sm"
              className={cn(!canSend && "disabled:opacity-100")}
              aria-label={t("toolbar.sendMessage")}
            >
              <IconArrowUp aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
