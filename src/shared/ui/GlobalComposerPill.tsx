import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useId,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import {
  IconArrowUp,
  IconMicrophone,
  IconPhone,
  IconPlus,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useProviderSelection } from "@/features/agents/hooks/useProviderSelection";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { selectPersonas } from "@/features/agents/stores/agentSelectors";
import { personaExecutionTarget } from "@/features/agents/lib/personaExecutionTarget";
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
import { ProjectInputSelector } from "@/features/chat/ui/ProjectInputSelector";
import type { SkillMentionItem } from "@/features/chat/ui/mentionDetection";
import { useVoiceDictation } from "@/features/chat/hooks/useVoiceDictation";
import { useVoiceConversationStore } from "@/features/voice-conversation/stores/voiceConversationStore";
import { getStoredModelPreference } from "@/features/chat/lib/modelPreferences";
import {
  normalizeSessionExecutionTarget,
  sameSessionExecutionTarget,
  type SessionExecutionTarget,
} from "@/features/chat/lib/sessionExecutionTarget";
import { makeRemountSafeDraftAttachments } from "@/features/chat/lib/draftAttachments";
import type {
  ChatInputReasoningEffort,
  ChatSendOptions,
  ChatSkillDraft,
  ModelOption,
} from "@/features/chat/types";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { resolveAgentProviderCatalogIdStrict } from "@/features/providers/providerCatalog";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useDefaultProviderReadinessStore } from "@/features/providers/stores/defaultProviderReadinessStore";
import { cn } from "@/shared/lib/cn";
import { isInteractiveElement } from "@/shared/lib/isInteractiveElement";
import { Button } from "@/shared/ui/button";
import { ComposerActionButton } from "@/shared/ui/composer-action-button";
import { Popover, PopoverAnchor } from "@/shared/ui/popover";
import type { ChatAttachmentDraft } from "@/shared/types/messages";
import { useFocusRegion } from "@/app/focus/FocusRegionProvider";
import { useTextareaAutosize } from "@/shared/hooks/useTextareaAutosize";
import { useVoiceDictationShortcutTarget } from "@/features/chat/lib/voiceDictationShortcutController";

export interface GlobalComposeOptions {
  executionTarget?: SessionExecutionTarget;
  projectId?: string | null;
  attachments?: ChatAttachmentDraft[];
  personaId?: string | null;
  sendOptions?: ChatSendOptions;
  reasoningEffort?: {
    configId: string;
    value: string;
  };
  /** SSH host the new chat's backend should run on (remote sessions). */
  remoteHost?: string;
  /** Remote working directory; required alongside remoteHost. */
  remoteWorkingDir?: string;
}

export interface GlobalComposerExpandPayload {
  text: string;
  selectedSkills: ChatSkillDraft[];
  options?: GlobalComposeOptions;
}

export interface GlobalComposerHandoffRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GlobalComposerStarterRequest {
  id: number;
  personaId?: string | null;
  projectId?: string | null;
  skill?: ChatSkillDraft;
}

interface GlobalComposerPillProps {
  hidden?: boolean;
  focusRequest?: number;
  elevated?: boolean;
  onSend: (text: string, options?: GlobalComposeOptions) => void;
  onExpand?: (
    payload: GlobalComposerExpandPayload,
  ) => boolean | undefined | Promise<boolean | undefined>;
  onDismiss?: () => void;
  onHandoffStart?: (rect: GlobalComposerHandoffRect) => void;
  suggestedPersonaId?: string | null;
  reasoningEffort?: ChatInputReasoningEffort;
  currentExecutionTarget?: SessionExecutionTarget | null;
  onExecutionTargetChange?: (target: SessionExecutionTarget | null) => void;
  placement?: "docked" | "centered" | "handoff";
  mainLeftOffsetPx?: number;
  handoffSourceRect?: GlobalComposerHandoffRect | null;
  handoffTargetRect?: GlobalComposerHandoffRect | null;
  starterRequest?: GlobalComposerStarterRequest | null;
  onStarterRequestConsumed?: (requestId: number) => void;
  voiceConversation?: {
    enabled: boolean;
    ready: boolean;
    onStart: (payload: GlobalComposerExpandPayload) => Promise<boolean>;
  };
}

interface ModelSelection {
  modelProviderId: string;
  modelId: string;
  modelName: string;
}

function executionTargetForSelection(
  harnessId: string,
  model: ModelSelection | null,
  selectedProviderId: string,
): SessionExecutionTarget {
  return normalizeSessionExecutionTarget({
    harnessId,
    modelProviderId:
      model?.modelProviderId ??
      (harnessId === "goose" && selectedProviderId !== harnessId
        ? selectedProviderId
        : undefined),
    modelId: model?.modelId,
    modelName: model?.modelName,
  });
}

const MODEL_ALIAS_IDS = new Set(["current", "default"]);

const TEXTAREA_MAX_HEIGHT_PX = 200;
const COMPOSER_ACTION_STRIP_CLASS = "h-[40px]";
// Geometry of the trailing action cluster, used to reserve space for it.
// Keep in sync with the buttons' `icon-pill-sm` size and the cluster's gap-2.
const COMPOSER_ACTION_BUTTON_WIDTH_PX = 40;
const COMPOSER_ACTION_GAP_PX = 8;
// Breathing room between the cluster and the content that stops short of it.
const COMPOSER_ACTION_GUTTER_PX = 8;

const COMPOSER_LAYOUT_TRANSITION_CLASS =
  "transition-[height,min-height,padding] duration-300 ease-in-out motion-reduce:transition-none";
const COMPOSER_TEXT_SLIDE_TRANSITION_CLASS =
  "transition-[min-height,padding] duration-300 ease-in-out motion-reduce:transition-none";
const COMPOSER_TOOLBAR_SLIDE_TRANSITION_CLASS =
  "transition-[transform,opacity] duration-300 ease-in-out motion-reduce:transition-none";

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
  const modelProviderId = model.providerId ?? fallbackProviderId;
  return {
    modelProviderId,
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
  hidden = false,
  focusRequest = 0,
  elevated = false,
  onSend,
  onExpand,
  onDismiss,
  onHandoffStart,
  suggestedPersonaId = null,
  reasoningEffort,
  currentExecutionTarget,
  onExecutionTargetChange,
  placement = "docked",
  mainLeftOffsetPx = 0,
  handoffSourceRect,
  handoffTargetRect,
  starterRequest = null,
  onStarterRequestConsumed,
  voiceConversation,
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
  const [voiceStartPending, setVoiceStartPending] = useState(false);
  const personas = useAgentStore(selectPersonas);
  const catalogEntries = useProviderCatalogStore((state) => state.entries);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerElement, setContainerElement] =
    useState<HTMLDivElement | null>(null);
  const lastFocusRequestRef = useRef(
    placement === "centered" ? 0 : focusRequest,
  );
  const lastStarterRequestIdRef = useRef(0);
  const [previousSuggestedPersonaId, setPreviousSuggestedPersonaId] = useState<
    string | null
  >(suggestedPersonaId);
  const personaSelectionSourceRef = useRef<"none" | "route" | "user">("none");
  const userTouchedRoutePersonaRef = useRef(false);
  // True when the current provider/model overrides were seeded from the
  // selected persona (rather than chosen by the user). Persona-driven overrides
  // do not count as draft content, so the route persona can still auto-clear.
  const personaOverrideActiveRef = useRef(false);
  // Persona id whose provider/model overrides have been applied, so we only
  // apply once per persona but still retry if providers load in late.
  const personaOverrideAppliedForRef = useRef<{
    personaId: string;
    identity: string;
  } | null>(null);
  const personaOverrideUserOverrideForRef = useRef<string | null>(null);

  const getTextareaMaxHeightPx = useCallback(() => TEXTAREA_MAX_HEIGHT_PX, []);
  const {
    attachments,
    addBrowserFiles,
    addPathAttachments,
    removeAttachment,
    clearAttachments,
  } = useChatInputAttachments();
  const attachmentWorkPending = attachmentWorkCount > 0;
  const [expandPending, setExpandPending] = useState(false);
  const { resetHeight: resetTextarea } = useTextareaAutosize({
    textareaRef,
    value: text,
    getMaxHeightPx: getTextareaMaxHeightPx,
    layoutKey: `${focused}:${modelPickerOpen}:${projectPickerOpen}:${placement}:${attachments.length}:${selectedPersonaId ?? ""}:${selectedSkills.length}`,
  });

  const runAttachmentWork = useCallback((task: () => Promise<void>) => {
    setAttachmentWorkCount((count) => count + 1);
    void task().finally(() => {
      setAttachmentWorkCount((count) => Math.max(0, count - 1));
    });
  }, []);

  const handleFileMentionAttachmentSelect = useCallback(
    (file: { resolvedPath: string }) => {
      runAttachmentWork(() => addPathAttachments([file.resolvedPath]));
    },
    [addPathAttachments, runAttachmentWork],
  );

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
    selectedProjectId !== null ||
    ((providerOverride !== null || modelOverride !== null) &&
      !personaOverrideActiveRef.current);
  const handoffActive = placement === "handoff";

  // Adopt the route-suggested persona inline as the route, draft, or selection
  // changes — instead of in an effect — so the composer never paints a stale
  // persona for a frame. A `prev`-prop comparison resets the user-touched flag
  // when the route changes; the adoption itself is self-guarded by the
  // `selectedPersonaId` checks so it converges and re-applies safely even if a
  // render is discarded.
  if (previousSuggestedPersonaId !== suggestedPersonaId) {
    setPreviousSuggestedPersonaId(suggestedPersonaId);
    userTouchedRoutePersonaRef.current = false;
  }

  if (!suggestedPersonaId) {
    if (personaSelectionSourceRef.current === "route" && !hasDraftContent) {
      if (selectedPersonaId !== null) {
        setSelectedPersonaId(null);
      }
      personaSelectionSourceRef.current = "none";
    }
  } else if (
    !hasDraftContent &&
    !userTouchedRoutePersonaRef.current &&
    selectedPersonaId !== suggestedPersonaId
  ) {
    setSelectedPersonaId(suggestedPersonaId);
    personaSelectionSourceRef.current = "route";
  }

  useEffect(() => {
    if (focusRequest <= lastFocusRequestRef.current) {
      lastFocusRequestRef.current = focusRequest;
      return;
    }
    lastFocusRequestRef.current = focusRequest;
    textareaRef.current?.focus();
  }, [focusRequest]);

  useEffect(() => {
    if (
      !starterRequest ||
      starterRequest.id <= lastStarterRequestIdRef.current
    ) {
      if (starterRequest) {
        onStarterRequestConsumed?.(starterRequest.id);
      }
      return;
    }

    lastStarterRequestIdRef.current = starterRequest.id;
    if (starterRequest.personaId !== undefined) {
      setSelectedPersonaId(starterRequest.personaId);
      personaSelectionSourceRef.current = starterRequest.personaId
        ? "user"
        : "none";
      userTouchedRoutePersonaRef.current = true;
      personaOverrideUserOverrideForRef.current = null;
    }
    if (starterRequest.projectId !== undefined) {
      setSelectedProjectId(starterRequest.projectId);
    }
    const skill = starterRequest.skill;
    if (skill) {
      setSelectedSkills((current) =>
        current.some((selected) => selected.id === skill.id)
          ? current
          : [...current, skill],
      );
    }
    textareaRef.current?.focus();
    onStarterRequestConsumed?.(starterRequest.id);
  }, [onStarterRequestConsumed, starterRequest]);

  const handleRemoveSelectedSkill = useCallback((skillId: string) => {
    setSelectedSkills((current) =>
      current.filter((skill) => skill.id !== skillId),
    );
  }, []);

  const clearSentContent = useCallback(() => {
    setText("");
    clearAttachments();
    setSelectedSkills([]);
  }, [clearAttachments]);

  const clearComposerSelections = useCallback(() => {
    setProviderOverride(null);
    setModelOverride(null);
    setSelectedProjectId(null);
    setSelectedPersonaId(null);
    personaSelectionSourceRef.current = "none";
    userTouchedRoutePersonaRef.current = false;
    personaOverrideActiveRef.current = false;
    personaOverrideAppliedForRef.current = null;
    personaOverrideUserOverrideForRef.current = null;
  }, []);

  // A centered send keeps the toolbar selections (project, persona, model) so
  // the pill morphing into the chat composer shows the same context the chat
  // composer will show — instead of flashing "No project" mid-flight. Once the
  // handoff placement ends, the chat composer owns that state, so reset the
  // pill for its next use.
  const previousPlacementRef = useRef(placement);
  useEffect(() => {
    const previousPlacement = previousPlacementRef.current;
    previousPlacementRef.current = placement;
    if (previousPlacement === "handoff" && placement !== "handoff") {
      clearSentContent();
      clearComposerSelections();
    }
  }, [placement, clearSentContent, clearComposerSelections]);

  const handlePersonaChange = useCallback((personaId: string | null) => {
    setSelectedPersonaId(personaId);
    personaSelectionSourceRef.current = personaId ? "user" : "none";
    userTouchedRoutePersonaRef.current = true;
    personaOverrideUserOverrideForRef.current = null;
  }, []);

  const placeholder = t("globalPill.placeholder");
  const selectedProviderForPicker =
    providerOverride ?? currentExecutionTarget?.harnessId ?? selectedProvider;
  const {
    selectedAgentId,
    pickerAgents,
    availableModels,
    getModelsForAgent,
    isModelInventoryAuthoritative,
    modelsLoading,
    modelStatusMessage,
    handleProviderChange,
    handleModelChange,
    handlePickerOpen,
  } = useAgentModelPickerState({
    providers,
    selectedProvider: selectedProviderForPicker,
    onProviderSelected: (providerId, providerModels) => {
      personaOverrideUserOverrideForRef.current = selectedPersonaId;
      personaOverrideActiveRef.current = false;
      const nextModel = getPreferredModel(providerModels, providerId);
      const nextTarget = executionTargetForSelection(
        providerId,
        nextModel,
        providerId,
      );
      onExecutionTargetChange?.(nextTarget);
      setProviderOverride(providerId);
      setModelOverride(nextModel);
      setSelectedProvider(providerId);
    },
    onModelSelected: (model) => {
      const selection = modelOptionToSelection(
        model,
        selectedProviderForPicker,
      );
      personaOverrideUserOverrideForRef.current = selectedPersonaId;
      personaOverrideActiveRef.current = false;
      onExecutionTargetChange?.(
        executionTargetForSelection(
          selectedAgentId,
          selection,
          selectedProviderForPicker,
        ),
      );
      setProviderOverride(selectedAgentId);
      setModelOverride(selection);
      setSelectedProvider(selectedAgentId);
    },
  });

  const personaTarget = useMemo(
    () =>
      personaExecutionTarget(selectedPersona, {
        providers,
        models: getModelsForAgent("goose"),
        getModelsForHarness: getModelsForAgent,
        catalogEntries,
      }),
    [catalogEntries, getModelsForAgent, providers, selectedPersona],
  );

  useEffect(() => {
    if (!selectedPersonaId) {
      personaOverrideActiveRef.current = false;
      personaOverrideAppliedForRef.current = null;
      personaOverrideUserOverrideForRef.current = null;
      return;
    }
    if (personaOverrideUserOverrideForRef.current === selectedPersonaId) {
      return;
    }

    const clearPersonaOverride = () => {
      if (!personaOverrideActiveRef.current) return;
      setProviderOverride(null);
      setModelOverride(null);
      personaOverrideActiveRef.current = false;
    };
    const persona = selectedPersona;
    const identity = [
      selectedPersonaId,
      persona?.provider,
      persona?.modelProviderId,
      persona?.model,
    ].join("\u0000");
    const appliedOverride = personaOverrideAppliedForRef.current;
    if (
      appliedOverride?.personaId === selectedPersonaId &&
      appliedOverride.identity === identity
    ) {
      return;
    }

    if (!personaTarget) {
      clearPersonaOverride();
      // Inventory-backed legacy targets may become resolvable after startup.
      // Do not mark an unresolved attempt as applied; the target changing will
      // rerun this effect without disturbing the current Composer selection.
      return;
    }

    setProviderOverride(personaTarget.harnessId);
    setModelOverride(
      personaTarget.modelId
        ? {
            modelProviderId: personaTarget.modelProviderId,
            modelId: personaTarget.modelId,
            modelName: personaTarget.modelName,
          }
        : null,
    );
    personaOverrideActiveRef.current = true;
    personaOverrideAppliedForRef.current = {
      personaId: selectedPersonaId,
      identity,
    };
  }, [personaTarget, selectedPersona, selectedPersonaId]);

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

      if (
        matchingModel ||
        (storedSelectionCompatible &&
          (availableModels.length === 0 ||
            !isModelInventoryAuthoritative(storedPreference.providerId)))
      ) {
        const modelProviderId =
          matchingModel?.providerId ?? storedPreference.providerId;
        if (!modelProviderId || modelProviderId === "goose") {
          return null;
        }
        return {
          modelProviderId,
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
        gooseDefaultSelection.modelProviderId === concreteSelectedProviderId)
    ) {
      const matchingDefault = findMatchingModel(
        availableModels,
        gooseDefaultSelection.modelId,
        gooseDefaultSelection.modelProviderId,
      );
      if (matchingDefault) {
        return modelOptionToSelection(
          matchingDefault,
          selectedProviderForPicker,
        );
      }
      if (
        !isModelInventoryAuthoritative(gooseDefaultSelection.modelProviderId)
      ) {
        return gooseDefaultSelection;
      }
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
    isModelInventoryAuthoritative,
    selectedAgentId,
    selectedProviderForPicker,
  ]);
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const controlledModelSelection = useMemo<ModelSelection | null>(() => {
    if (!currentExecutionTarget?.modelId) {
      return null;
    }

    return {
      modelProviderId: currentExecutionTarget.modelProviderId,
      modelId: currentExecutionTarget.modelId,
      modelName: currentExecutionTarget.modelName,
    };
  }, [currentExecutionTarget]);
  const hasLocalExecutionOverride =
    providerOverride !== null || modelOverride !== null;
  const effectiveModelSelection =
    modelOverride ??
    (!hasLocalExecutionOverride && currentExecutionTarget !== undefined
      ? controlledModelSelection
      : defaultModelSelection);
  const localExecutionTarget = useMemo(
    () =>
      hasLocalExecutionOverride || currentExecutionTarget === undefined
        ? executionTargetForSelection(
            selectedAgentId,
            effectiveModelSelection,
            selectedProviderForPicker,
          )
        : undefined,
    [
      currentExecutionTarget,
      effectiveModelSelection,
      hasLocalExecutionOverride,
      selectedAgentId,
      selectedProviderForPicker,
    ],
  );
  const personaSelectionOverridden =
    personaOverrideUserOverrideForRef.current === selectedPersonaId;
  const effectiveExecutionTarget =
    !personaSelectionOverridden && personaTarget
      ? personaTarget
      : (localExecutionTarget ?? currentExecutionTarget ?? undefined);
  const canSend =
    hasSendableContent &&
    Boolean(effectiveExecutionTarget) &&
    !attachmentWorkPending &&
    !handoffActive;

  useEffect(() => {
    if (
      localExecutionTarget &&
      sameSessionExecutionTarget(currentExecutionTarget, localExecutionTarget)
    ) {
      setProviderOverride(null);
      setModelOverride(null);
    }
  }, [currentExecutionTarget, localExecutionTarget]);

  const reasoningEffortSelectionMatch = useMemo(() => {
    const effortProviderId = currentExecutionTarget?.modelProviderId;
    const effortModelId = currentExecutionTarget?.modelId;
    const selectedProviderId =
      effectiveModelSelection?.modelProviderId ?? selectedProviderForPicker;
    const selectedModelId = effectiveModelSelection?.modelId;
    const providerMatches =
      !effortProviderId ||
      !selectedProviderId ||
      selectedProviderId === effortProviderId;
    const modelMatches =
      !effortModelId || !selectedModelId || selectedModelId === effortModelId;

    return {
      effortProviderId,
      effortModelId,
      selectedProviderId,
      selectedModelId,
      providerMatches,
      modelMatches,
    };
  }, [
    effectiveModelSelection?.modelId,
    effectiveModelSelection?.modelProviderId,
    currentExecutionTarget?.modelId,
    currentExecutionTarget?.modelProviderId,
    selectedProviderForPicker,
  ]);
  const activeReasoningEffort =
    reasoningEffort?.config &&
    reasoningEffortSelectionMatch.providerMatches &&
    reasoningEffortSelectionMatch.modelMatches
      ? reasoningEffort
      : undefined;

  const {
    mentionOpen,
    atMentionCategory,
    mentionSelectedIndex,
    filteredPersonas,
    filteredSkills,
    filteredFiles,
    fileMentionsLoading,
    fileMentionsError,
    detectMention,
    dismissMention,
    navigateMention,
    setAtMentionCategory,
    handleMentionCategoryKey,
    confirmMention,
    handleMentionConfirm,
  } = useMentionHandlers({
    personas,
    skillProjectDirs: selectedProject?.workingDirs,
    fileMentionProjectDirs: selectedProject?.workingDirs,
    skillsEnabled: true,
    fileMentionsEnabled: true,
    text,
    setText,
    textareaRef,
    activePersonaId: selectedPersonaId,
    onPersonaChange: handlePersonaChange,
    onSkillMentionSelect: handleSkillMentionSelected,
    onFileMentionSelect: handleFileMentionAttachmentSelect,
    skillProviderId:
      modelOverride?.modelProviderId ??
      providerOverride ??
      selectedProviderForPicker,
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
      options.executionTarget = effectiveExecutionTarget;
      if (selectedProjectId) {
        options.projectId = selectedProjectId;
      }
      options.personaId = selectedPersonaId;
      if (activeReasoningEffort?.config) {
        options.reasoningEffort = {
          configId: activeReasoningEffort.config.configId,
          value: activeReasoningEffort.config.currentValue,
        };
      }
      const { messageText, sendOptions } = buildSkillSendPayload(
        trimmed,
        selectedSkills,
        null,
        {
          providerId:
            modelOverride?.modelProviderId ??
            providerOverride ??
            selectedProviderForPicker,
        },
      );
      if (sendOptions) {
        options.sendOptions = sendOptions;
      }

      if (placement === "centered") {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
          onHandoffStart?.({
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          });
        }
        // Keep toolbar selections during the handoff animation; the
        // placement-change effect clears them once the handoff completes.
        clearSentContent();
      }

      onSend(messageText, options);
      if (placement !== "centered") {
        clearSentContent();
        clearComposerSelections();
      }
      return true;
    },
    [
      attachments,
      clearComposerSelections,
      clearSentContent,
      effectiveExecutionTarget,
      modelOverride,
      onHandoffStart,
      onSend,
      providerOverride,
      activeReasoningEffort?.config,
      placement,
      selectedPersonaId,
      selectedProjectId,
      selectedProviderForPicker,
      selectedSkills,
    ],
  );

  const handleExpand = useCallback(() => {
    if (!onExpand || attachmentWorkPending || handoffActive || expandPending) {
      return;
    }

    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      onHandoffStart?.({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      });
    }

    const options: GlobalComposeOptions = {};
    const remountSafeAttachments = makeRemountSafeDraftAttachments(attachments);
    if (remountSafeAttachments.length > 0) {
      options.attachments = remountSafeAttachments;
    }
    options.executionTarget = effectiveExecutionTarget;
    if (selectedProjectId) {
      options.projectId = selectedProjectId;
    }
    options.personaId = selectedPersonaId;
    if (activeReasoningEffort?.config) {
      options.reasoningEffort = {
        configId: activeReasoningEffort.config.configId,
        value: activeReasoningEffort.config.currentValue,
      };
    }

    const payload: GlobalComposerExpandPayload = {
      text,
      selectedSkills,
      options,
    };

    setExpandPending(true);
    void Promise.resolve(onExpand(payload))
      .then((accepted) => {
        if (accepted === false) {
          return;
        }

        clearSentContent();
        clearComposerSelections();
      })
      .catch((error) => {
        console.error("Failed to expand global composer:", error);
      })
      .finally(() => {
        setExpandPending(false);
      });
  }, [
    activeReasoningEffort?.config,
    attachmentWorkPending,
    attachments,
    clearComposerSelections,
    clearSentContent,
    effectiveExecutionTarget,
    expandPending,
    handoffActive,
    onExpand,
    onHandoffStart,
    selectedPersonaId,
    selectedProjectId,
    selectedSkills,
    text,
  ]);

  const nativeVoiceLifecycle = useVoiceConversationStore(
    (state) => state.status.lifecycle,
  );
  const nativeVoiceOwnsMicrophone =
    nativeVoiceLifecycle === "starting" ||
    nativeVoiceLifecycle === "running" ||
    nativeVoiceLifecycle === "stopping";

  const dictation = useVoiceDictation({
    text,
    setText,
    attachments,
    clearAttachments,
    selectedPersonaId: null,
    onSend: (draftText) =>
      attachmentWorkPending ? false : submitCompose(draftText),
    resetTextarea,
    isSendLocked: attachmentWorkPending,
  });
  const dictationOwnsMicrophone =
    dictation.isRecording || dictation.isTranscribing || dictation.isStarting();

  const handleVoiceDictationShortcut = useVoiceDictationShortcutTarget(
    textareaRef,
    {
      surface: placement === "centered" ? "centered-global" : "home-global",
      canStart: dictation.isEnabled && !handoffActive,
      isRecording: dictation.isRecording,
      toggle: dictation.toggleRecording,
    },
  );

  useEffect(() => {
    if (selectedAgentId !== "goose") {
      setGooseDefaultSelection(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const readiness =
          useDefaultProviderReadinessStore.getState().readiness ??
          (await useDefaultProviderReadinessStore
            .getState()
            .refresh({ coalesce: true }));

        if (cancelled) {
          return;
        }

        const providerId =
          readiness.status === "ready"
            ? readiness.providerId
            : selectedProvider;
        const modelId =
          readiness.status === "ready" ? readiness.modelId : undefined;

        setGooseDefaultSelection(
          modelId
            ? {
                modelProviderId: providerId,
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
  const visiblePlaceholder = handoffActive ? "" : effectivePlaceholder;
  useFocusRegion(
    useMemo(
      () => ({
        id: "composer",
        label: "composer",
        key: "c",
        enabled: true,
        element: containerElement,
        getInitialFocus: () => textareaRef.current,
      }),
      [containerElement],
    ),
  );

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

  const handleStartVoiceConversation = useCallback(async () => {
    if (
      !voiceConversation?.enabled ||
      !effectiveExecutionTarget ||
      effectiveExecutionTarget.harnessId !== "goose" ||
      voiceStartPending ||
      handoffActive ||
      attachmentWorkPending ||
      dictationOwnsMicrophone
    ) {
      return;
    }

    const options: GlobalComposeOptions = {};
    const remountSafeAttachments = makeRemountSafeDraftAttachments(attachments);
    if (remountSafeAttachments.length > 0) {
      options.attachments = remountSafeAttachments;
    }
    options.executionTarget = effectiveExecutionTarget;
    if (selectedProjectId) options.projectId = selectedProjectId;
    options.personaId = selectedPersonaId;
    if (activeReasoningEffort?.config) {
      options.reasoningEffort = {
        configId: activeReasoningEffort.config.configId,
        value: activeReasoningEffort.config.currentValue,
      };
    }

    setVoiceStartPending(true);
    try {
      const accepted = await voiceConversation.onStart({
        text,
        selectedSkills,
        options,
      });
      if (!accepted) return;
      clearSentContent();
      clearComposerSelections();
    } catch (error) {
      console.error("Failed to start voice conversation:", error);
    } finally {
      setVoiceStartPending(false);
    }
  }, [
    activeReasoningEffort?.config,
    attachmentWorkPending,
    attachments,
    clearComposerSelections,
    clearSentContent,
    dictationOwnsMicrophone,
    effectiveExecutionTarget,
    handoffActive,
    selectedPersonaId,
    selectedProjectId,
    selectedSkills,
    text,
    voiceConversation,
    voiceStartPending,
  ]);

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
  const handleContainerRef = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    setContainerElement(node);
  }, []);
  const handleContainerMouseDown = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      if (handoffActive || !(event.target instanceof Element)) {
        return;
      }

      if (isInteractiveElement(event.target)) {
        return;
      }

      event.preventDefault();
      textareaRef.current?.focus({ preventScroll: true });
    },
    [handoffActive],
  );
  // The trailing action cluster is absolutely positioned, so the toolbar and
  // textarea have to reserve its width themselves. Derive that from the number
  // of buttons actually rendered: a hardcoded inset silently overlaps the
  // project chip as soon as an optional button (voice conversation) appears.
  const trailingActionCount =
    1 +
    (voiceConversation?.enabled ? 1 : 0) +
    (dictation.isEnabled || dictation.isRecording ? 1 : 0);
  const actionsInset = `${
    trailingActionCount * COMPOSER_ACTION_BUTTON_WIDTH_PX +
    (trailingActionCount - 1) * COMPOSER_ACTION_GAP_PX +
    COMPOSER_ACTION_GUTTER_PX
  }px`;
  const composerStyle = {
    "--global-composer-actions-inset": actionsInset,
    "--global-composer-main-left": `${mainLeftOffsetPx}px`,
    "--global-composer-from-left": `${handoffSourceRect?.left ?? 0}px`,
    "--global-composer-from-top": `${handoffSourceRect?.top ?? 0}px`,
    "--global-composer-from-width": `${handoffSourceRect?.width ?? 0}px`,
    "--global-composer-from-height": `${handoffSourceRect?.height ?? 0}px`,
    "--global-composer-to-left": `${handoffTargetRect?.left ?? handoffSourceRect?.left ?? 0}px`,
    "--global-composer-to-top": `${handoffTargetRect?.top ?? handoffSourceRect?.top ?? 0}px`,
    "--global-composer-to-width": `${handoffTargetRect?.width ?? handoffSourceRect?.width ?? 0}px`,
    "--global-composer-to-height": `${handoffTargetRect?.height ?? handoffSourceRect?.height ?? 0}px`,
  } as CSSProperties;
  const placementClassName =
    placement === "handoff" && handoffSourceRect
      ? "global-composer-pill-flip fixed overflow-hidden"
      : placement === "docked"
        ? "bottom-3 right-3 w-[482px] max-w-[calc(100vw-24px)]"
        : "left-[calc(var(--global-composer-main-left)+(100vw-var(--global-composer-main-left))/2)] top-1/2 w-[min(680px,calc(100vw-var(--global-composer-main-left)-48px))] max-w-[calc(100vw-24px)] -translate-x-1/2 -translate-y-1/2 shadow-global-composer-pill-hover";

  return (
    <div
      hidden={hidden}
      ref={handleContainerRef}
      role="region"
      aria-label={t("globalPill.ariaLabel")}
      data-placement={placement}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onMouseDown={handleContainerMouseDown}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setFocused(false);
        }
      }}
      style={{
        ...composerStyle,
        display: hidden ? "none" : undefined,
      }}
      className={cn(
        "global-composer-pill group relative fixed z-40 isolate flex flex-col rounded-composer bg-card-glass py-2 pl-4 pr-2.5 [backdrop-filter:var(--backdrop-panel)] [-webkit-backdrop-filter:var(--backdrop-panel)] transition-[box-shadow,opacity,transform] duration-300 ease-out hover:shadow-global-composer-pill-hover",
        placementClassName,
        elevated && placement === "docked" && "shadow-elevated",
        placement === "centered" && "global-composer-pill-centered",
        placement === "handoff" &&
          "pointer-events-none global-composer-pill-handoff",
        placement === "handoff" &&
          !handoffTargetRect &&
          "global-composer-pill-handoff-pending",
      )}
    >
      {onExpand ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={handleExpand}
          disabled={attachmentWorkPending || handoffActive || expandPending}
          aria-label={t("globalPill.expand")}
          tooltip={t("globalPill.expand")}
          tabIndex={
            attachmentWorkPending || handoffActive || expandPending
              ? -1
              : undefined
          }
          className={cn(
            "absolute z-20 h-6 w-6 rounded-sm transition-[color,opacity] duration-150 ease-out hover:text-foreground hover:opacity-100 focus-visible:opacity-100 disabled:pointer-events-none disabled:opacity-0",
            expanded
              ? "-top-1.5 -left-1.5 text-muted-foreground/50 opacity-60"
              : "-top-2 -left-2 text-muted-foreground/60 opacity-0 group-hover:opacity-100",
          )}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            fill="none"
            className="h-[18px] w-[18px] -rotate-2"
          >
            <path
              d="M4 12V4H12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Button>
      ) : null}
      {isAttachmentDragOver ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-composer border border-dashed border-border/80 bg-card/60">
          <span className="rounded-md bg-secondary px-3 py-1 text-sm text-secondary-foreground">
            {t("attachments.dropToAttach")}
          </span>
        </div>
      ) : null}
      {(selectedPersona || selectedSkills.length > 0) && (
        <div className="px-2 pt-1">
          <ChatInputSelectionChips
            persona={selectedPersona ?? null}
            skills={selectedSkills}
            onRemovePersona={() => handlePersonaChange(null)}
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

      <div
        className={cn(
          "relative w-full px-2",
          COMPOSER_LAYOUT_TRANSITION_CLASS,
          expanded ? "pb-[40px]" : "h-[40px]",
        )}
      >
        <div
          className={cn(
            "relative z-[1] min-w-0",
            COMPOSER_TEXT_SLIDE_TRANSITION_CLASS,
            !expanded && "flex h-full items-center",
          )}
        >
          <Popover open={mentionOpen}>
            <div
              id={mentionStatusId}
              role="status"
              aria-live="polite"
              className="sr-only"
            >
              {mentionStatusText}
            </div>
            {/* No data-chat-composer marker here on purpose: this pill
                drafts a new conversation, so the archive-session shortcut
                (default mod+e) stays blocked while it has focus instead of
                archiving the session behind the centered overlay. */}
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
                  const isComposing =
                    event.nativeEvent.isComposing ||
                    event.nativeEvent.keyCode === 229;
                  if (handleVoiceDictationShortcut(event.nativeEvent)) {
                    event.stopPropagation();
                    return;
                  }
                  if (
                    !isComposing &&
                    handleMentionCategoryKey(event.nativeEvent)
                  ) {
                    event.preventDefault();
                    return;
                  }
                  if (mentionOpen && !isComposing) {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      dismissMention();
                      return;
                    }
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      navigateMention(
                        event.key === "ArrowDown" ? "down" : "up",
                      );
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
                        handleMentionConfirm(item, {
                          completeDirectories: true,
                        });
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
                    return;
                  }
                  if (
                    event.key === "Escape" &&
                    !mentionOpen &&
                    placement !== "docked"
                  ) {
                    event.preventDefault();
                    onDismiss?.();
                  }
                }}
                onPaste={handlePaste}
                onFocus={() => setFocused(true)}
                placeholder={visiblePlaceholder}
                readOnly={handoffActive}
                aria-controls={mentionOpen ? mentionListboxId : undefined}
                aria-describedby={mentionOpen ? mentionStatusId : undefined}
                className={cn(
                  "focus-override max-h-[200px] w-full resize-none appearance-none overflow-y-auto overscroll-contain scrollbar-none border-0 bg-transparent text-sm leading-5 text-foreground outline-none placeholder:text-foreground/40 placeholder:transition-colors placeholder:duration-200 placeholder:ease-out group-hover:placeholder:text-foreground group-focus-within:placeholder:text-foreground focus:outline-none focus:ring-0",
                  handoffActive && "caret-transparent",
                  expanded
                    ? "min-h-10 py-2.5 pr-2"
                    : "h-8 min-h-0 py-0 pr-[var(--global-composer-actions-inset)]",
                )}
              />
            </PopoverAnchor>
            <MentionAutocomplete
              isOpen={mentionOpen}
              filteredPersonas={filteredPersonas}
              filteredSkills={filteredSkills}
              filteredFiles={filteredFiles}
              atCategory={atMentionCategory}
              onAtCategoryChange={setAtMentionCategory}
              selectedIndex={mentionSelectedIndex}
              onSelectPersona={(persona) =>
                handleMentionConfirm({ type: "persona", persona })
              }
              onSelectSkill={(skill) =>
                handleMentionConfirm({ type: "skill", skill })
              }
              onSelectFile={(file) =>
                handleMentionConfirm({ type: "file", file })
              }
              onDismiss={dismissMention}
              listboxId={mentionListboxId}
              pathsLoading={fileMentionsLoading}
              pathsError={fileMentionsError}
            />
          </Popover>
        </div>
      </div>

      <div
        data-role="composer-action-strip"
        className={cn(
          "pointer-events-none absolute bottom-2 left-6 right-[1.125rem] z-20 flex items-center overflow-hidden pr-[var(--global-composer-actions-inset)]",
          COMPOSER_ACTION_STRIP_CLASS,
        )}
      >
        <div
          aria-hidden={!expanded}
          className={cn(
            "flex items-center gap-2",
            COMPOSER_TOOLBAR_SLIDE_TRANSITION_CLASS,
            expanded
              ? "pointer-events-auto relative h-full min-w-0 flex-1 translate-y-0 opacity-100"
              : "pointer-events-none absolute bottom-0 left-0 translate-y-4 opacity-0",
          )}
        >
          <ComposerActionButton
            type="button"
            tabIndex={expanded ? 0 : -1}
            onClick={() => {
              runAttachmentWork(handleAttachFiles);
            }}
            disabled={handoffActive}
            size="icon-pill-sm"
            aria-label={t("attachments.chooseFilesDialogTitle")}
          >
            <IconPlus aria-hidden="true" />
          </ComposerActionButton>

          <AgentModelPicker
            agents={pickerAgents}
            selectedAgentId={selectedAgentId}
            onAgentChange={handleProviderChange}
            currentModelId={effectiveModelSelection?.modelId ?? null}
            currentModelProviderId={
              effectiveModelSelection?.modelProviderId ?? null
            }
            currentModelName={effectiveModelSelection?.modelName ?? null}
            availableModels={availableModels}
            modelsLoading={modelsLoading}
            modelStatusMessage={modelStatusMessage}
            onModelChange={handleModelChange}
            onOpen={handlePickerOpen}
            onOpenChange={setModelPickerOpen}
            onRequestComposerFocus={() => textareaRef.current?.focus()}
            loading={providersLoading}
            isCompact
            triggerTabIndex={expanded ? 0 : -1}
            reasoningEffort={activeReasoningEffort}
            contentAlign="smart"
            contentCollisionPadding={16}
          />

          <ProjectInputSelector
            selectedProjectId={selectedProjectId}
            availableProjects={projects}
            onProjectChange={setSelectedProjectId}
            open={projectPickerOpen}
            onOpenChange={setProjectPickerOpen}
            onRequestComposerFocus={() => textareaRef.current?.focus()}
            triggerTabIndex={expanded ? 0 : -1}
            contentSide="top"
            modal={false}
          />
        </div>

        <div className="pointer-events-auto absolute inset-y-0 right-0 z-10 flex items-center gap-2">
          {voiceConversation?.enabled ? (
            <ComposerActionButton
              type="button"
              disabled={
                selectedAgentId !== "goose" ||
                voiceStartPending ||
                handoffActive ||
                attachmentWorkPending ||
                dictationOwnsMicrophone
              }
              onMouseDown={(event) => {
                if (voiceConversation.ready) {
                  event.preventDefault();
                }
              }}
              onClick={() => void handleStartVoiceConversation()}
              size="icon-pill-sm"
              aria-label={t("globalPill.startVoiceConversation")}
              tooltip={
                selectedAgentId === "goose"
                  ? t("globalPill.startVoiceConversation")
                  : t("globalPill.voiceConversationRequiresGoose")
              }
            >
              <IconPhone aria-hidden="true" />
            </ComposerActionButton>
          ) : null}
          {(dictation.isEnabled || dictation.isRecording) && (
            <ComposerActionButton
              type="button"
              disabled={
                (!dictation.isRecording && !dictation.isEnabled) ||
                nativeVoiceOwnsMicrophone
              }
              onClick={dictation.toggleRecording}
              size="icon-pill-sm"
              className={cn(
                dictation.isRecording &&
                  "bg-destructive/12 text-destructive hover:bg-destructive/16 hover:text-destructive active:bg-destructive/16 active:text-destructive",
                dictation.isTranscribing && "animate-pulse",
              )}
              aria-label={
                dictation.isRecording
                  ? t("toolbar.voiceInputRecording")
                  : t("toolbar.voiceInput")
              }
              aria-pressed={dictation.isRecording}
              tooltip={
                dictation.isRecording
                  ? t("toolbar.voiceInputRecording")
                  : dictation.isTranscribing
                    ? t("toolbar.voiceInputTranscribing")
                    : t("toolbar.voiceInput")
              }
            >
              <IconMicrophone aria-hidden="true" />
            </ComposerActionButton>
          )}
          <ComposerActionButton
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            size="icon-pill-sm"
            className={cn(!canSend && "disabled:opacity-100")}
            aria-label={t("toolbar.sendMessage")}
          >
            <IconArrowUp aria-hidden="true" />
          </ComposerActionButton>
        </div>
      </div>
    </div>
  );
}
