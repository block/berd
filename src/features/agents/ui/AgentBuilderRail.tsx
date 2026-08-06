import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconLayoutSidebarLeftExpand,
  IconPhoto,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";
import { avatarRef, parseAvatarRef } from "@/shared/avatars/catalog";
import { normalizeAvatarUrl } from "@/shared/lib/avatarUrl";
import { cn } from "@/shared/lib/cn";
import type { AgentSourceEntry } from "@/shared/api/agents";
import { useAvatarMediaState } from "@/shared/hooks/useAvatarSrc";
import { Button, buttonVariants } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { Spinner } from "@/shared/ui/spinner";
import { ToastActionButton } from "@/shared/ui/sonner";
import {
  useAvatarLibrary,
  type AvatarLibraryState,
} from "@/features/agents/hooks/useAvatarLibrary";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { selectPersonas } from "@/features/agents/stores/agentSelectors";
import {
  usePersonaSource,
  type PersonaSourcePatch,
} from "@/features/agents/hooks/usePersonaSource";
import {
  fileStem,
  isPlaceholderAgentName,
  PLACEHOLDER_AGENT_BODY,
  promoteDraft,
} from "@/features/agents/lib/agentBuilderSession";
import { AvatarCollectionOverlay } from "@/features/agents/ui/AvatarCollectionOverlay";
import { AvatarLibraryPicker } from "@/features/agents/ui/AvatarLibraryPicker";
import { GloopieAvatarCreator } from "@/features/agents/ui/GloopieAvatarCreator";
import { GloopieGenerationHero } from "@/features/agents/ui/GloopieGenerationHero";
import { useGloopieGeneration } from "@/features/agents/hooks/useGloopieGeneration";
import { useExperiment } from "@/features/experiments/experimentPreferences";
import {
  AVATAR_COLLECTION_PAGE_EXPERIMENT_ID,
  GLOOPIE_AVATAR_CREATOR_EXPERIMENT_ID,
} from "@/features/experiments/experimentDefinitions";
import {
  gloopieErrorMessageKey,
  hasGloopieGenerationWork,
  isUnresolvedGloopiePhase,
  resetGloopieGeneration,
  type UnresolvedGloopiePhase,
} from "@/features/agents/stores/gloopieGenerationStore";
import { ProviderModelFields } from "@/features/agents/ui/PersonaFields/ProviderModelFields";
import { FORM_FIELD_CLASS } from "@/shared/ui/form-field-tokens";

const FIELD_CLASS = FORM_FIELD_CLASS;
const FIELD_LABEL_CLASS = "mb-2 block text-xs text-muted-foreground";

/**
 * Design width of the builder rail. Containers that host the rail should size
 * their column from this constant so the rail is never clipped.
 */
export const AGENT_BUILDER_RAIL_WIDTH = 506;

/**
 * Why saving is blocked, per unresolved gloopie phase. Keyed by phase so the
 * copy and the `gloopieBlocksSave` condition cannot drift apart.
 */
const GLOOPIE_SAVE_BLOCKED_HELP_KEYS: Record<UnresolvedGloopiePhase, string> = {
  generating: "builderRail.gloopieGeneratingBeforeSave",
  choosing: "builderRail.chooseGloopieBeforeSave",
  animating: "builderRail.gloopieAnimatingBeforeSave",
  done: "builderRail.useGloopieBeforeSave",
};

export interface AgentBuilderRailProps {
  sessionId: string;
  targetAgentPath: string | null;
  /** Reserved for future deep-linking / re-binding by slug; not used in v1 render. */
  targetAgentSlug: string | null;
  draftState?: "preparing" | "failed" | null;
  className?: string;
  /** Switches to the two-column builder layout when chat is collapsed. */
  fullPage?: boolean;
  /** Reopens chat from the full-page builder header. */
  onExpandChat?: () => void;
  onDraftPromoted?: (source: AgentSourceEntry) => void;
  onDraftTargetChanged?: (target: { path: string; slug: string }) => void;
  onRecoverMissingDraft?: () => void | Promise<void>;
  onBack?: (source: AgentSourceEntry) => void;
  onClose?: () => void;
  onLocalEditStateChange?: (hasLocalEdits: boolean) => void;
  onSaveDraftHandlerChange?: (
    saveDraft: (() => boolean | Promise<boolean>) | null,
  ) => void;
}

export function AgentBuilderRail({
  sessionId,
  targetAgentPath,
  draftState = null,
  className,
  fullPage = false,
  onExpandChat,
  onDraftPromoted,
  onDraftTargetChanged,
  onRecoverMissingDraft,
  onBack,
  onClose,
  onLocalEditStateChange,
  onSaveDraftHandlerChange,
}: AgentBuilderRailProps) {
  const { t } = useTranslation(["agents", "common"]);
  const handleResolvedPathChange = useCallback(
    (source: AgentSourceEntry) => {
      onDraftTargetChanged?.({
        path: source.path,
        slug: fileStem(source.path),
      });
    },
    [onDraftTargetChanged],
  );
  const { data, isLoading, error, update, saveStatus, saveNow } =
    usePersonaSource(targetAgentPath, {
      builderSessionId: sessionId,
      onResolvedPathChange: handleResolvedPathChange,
    });
  const [isPromoting, setIsPromoting] = useState(false);
  const [avatarPanel, setAvatarPanel] = useState<
    "closed" | "library" | "gloopie"
  >("closed");
  const [recoveringMissingDraftKey, setRecoveringMissingDraftKey] = useState<
    string | null
  >(null);
  const [failedMissingDraftRecoveryKey, setFailedMissingDraftRecoveryKey] =
    useState<string | null>(null);
  const avatarLibrary = useAvatarLibrary(true);
  const gloopieExperiment = useExperiment(GLOOPIE_AVATAR_CREATOR_EXPERIMENT_ID);
  const gloopieCreatorEnabled = Boolean(gloopieExperiment?.enabled);
  const avatarCollectionExperiment = useExperiment(
    AVATAR_COLLECTION_PAGE_EXPERIMENT_ID,
  );
  // When on, "library" renders as the full-surface collection canvas overlay
  // (portal over the whole app) instead of the inline picker. The chat +
  // builder stay mounted underneath, so composer drafts, resize state, and
  // in-flight gloopie work all survive the takeover.
  const avatarCollectionOverlayEnabled = Boolean(
    avatarCollectionExperiment?.enabled,
  );
  const gloopieGeneration = useGloopieGeneration(avatarLibrary, sessionId);
  // Single gated source of truth for the phase. When the experiment is off the
  // flow reads as "never started", so every downstream derivation (status card,
  // save gating, full-page layout, background toasts) stays inert without each
  // one repeating the experiment check.
  const gloopiePhase = gloopieCreatorEnabled
    ? gloopieGeneration.phase
    : "prompt";
  // The creator panel can only be open while the experiment is on, so a stale
  // `avatarPanel` value can never render the gated surface.
  const gloopieCreatorOpen = gloopieCreatorEnabled && avatarPanel === "gloopie";
  const [gloopieBackgrounded, setGloopieBackgrounded] = useState(false);
  const isWaitingForDraftTarget = !targetAgentPath;
  const missingDraftRecoveryKey = `${sessionId}:${targetAgentPath ?? "pending"}`;
  const [previousMissingDraftRecoveryKey, setPreviousMissingDraftRecoveryKey] =
    useState(missingDraftRecoveryKey);
  if (previousMissingDraftRecoveryKey !== missingDraftRecoveryKey) {
    setPreviousMissingDraftRecoveryKey(missingDraftRecoveryKey);
    setRecoveringMissingDraftKey(null);
    setFailedMissingDraftRecoveryKey(null);
  }
  const shouldRecoverMissingDraft =
    !isWaitingForDraftTarget &&
    error === "missing" &&
    !data &&
    !isLoading &&
    Boolean(onRecoverMissingDraft) &&
    failedMissingDraftRecoveryKey !== missingDraftRecoveryKey;

  useEffect(() => {
    if (!shouldRecoverMissingDraft || !onRecoverMissingDraft) {
      return;
    }

    if (recoveringMissingDraftKey === missingDraftRecoveryKey) {
      return;
    }

    setRecoveringMissingDraftKey(missingDraftRecoveryKey);
    void Promise.resolve(onRecoverMissingDraft()).catch((error) => {
      console.error("Failed to recover missing agent draft:", error);
      setFailedMissingDraftRecoveryKey(missingDraftRecoveryKey);
      setRecoveringMissingDraftKey((current) =>
        current === missingDraftRecoveryKey ? null : current,
      );
    });
  }, [
    missingDraftRecoveryKey,
    onRecoverMissingDraft,
    recoveringMissingDraftKey,
    shouldRecoverMissingDraft,
  ]);

  const isRecoveringMissingDraft =
    shouldRecoverMissingDraft ||
    recoveringMissingDraftKey === missingDraftRecoveryKey;

  const avatarRaw =
    typeof data?.properties?.avatar === "string" ? data.properties.avatar : "";
  const trimmedAvatar = avatarRaw.trim();
  const normalizedAvatar = normalizeAvatarUrl(trimmedAvatar);
  const [selectedCollectionId, setSelectedCollectionId] = useState<
    string | null
  >(null);
  const selectedCollection = useMemo(
    () =>
      avatarLibrary.catalog?.collections.find(
        (collection) => collection.id === selectedCollectionId,
      ) ?? null,
    [avatarLibrary.catalog, selectedCollectionId],
  );

  const provider = (data?.properties?.provider as string | undefined) ?? "";
  const model = (data?.properties?.model as string | undefined) ?? "";

  const writeProperty = useCallback(
    (key: "provider" | "model" | "avatar", value: string | null) => {
      const patch: PersonaSourcePatch = {
        properties: { [key]: value },
      };
      update(patch);
    },
    [update],
  );

  const onSelectAvatar = useCallback(
    (avatarId: string) => {
      writeProperty("avatar", avatarRef(avatarId));
      setSelectedCollectionId(null);
      setAvatarPanel("closed");
    },
    [writeProperty],
  );

  const onUseGloopie = useCallback(
    (nextAvatarRef: string) => {
      writeProperty("avatar", nextAvatarRef);
      // Keep the ref we just committed; reset deletes the rest of the attempt.
      gloopieGeneration.reset({ keepRefs: [nextAvatarRef] });
      setGloopieBackgrounded(false);
      setSelectedCollectionId(null);
      setAvatarPanel("closed");
    },
    [gloopieGeneration, writeProperty],
  );

  const onOpenGloopieCreator = useCallback(() => {
    setGloopieBackgrounded(false);
    setAvatarPanel("gloopie");
  }, []);

  const onDiscardGloopie = useCallback(() => {
    gloopieGeneration.reset({ keepObject: true });
    setGloopieBackgrounded(false);
    setAvatarPanel("closed");
  }, [gloopieGeneration]);

  const onContinueGloopieSetup = useCallback(() => {
    setGloopieBackgrounded(true);
    setAvatarPanel("closed");
  }, []);

  // A finished gloopie is the avatar — the user already picked it from the
  // four options, so "done" commits it to the agent immediately instead of
  // asking again via a "use this avatar / start over" step. Runs whenever the
  // phase is `done` (not just on the transition) so work finished while this
  // rail was unmounted — the user was in another chat — lands the moment they
  // come back.
  const resultAvatarRef = gloopieGeneration.resultAvatarRef;
  useEffect(() => {
    if (gloopiePhase !== "done" || !resultAvatarRef) {
      return;
    }
    onUseGloopie(resultAvatarRef);
    toast.success(t("gloopie.avatarReadyToast"));
  }, [gloopiePhase, onUseGloopie, resultAvatarRef, t]);

  // Turning the experiment off mid-flight strands whatever the attempt already
  // produced: the gated phase reads "prompt", so the auto-commit effect above
  // never fires and the status card disappears, leaving generated files on disk
  // with nothing pointing at them. Abandon the job so its media is deleted.
  //
  // This cannot delete a committed avatar: "use this avatar" resets the job
  // (retaining the ref it just wrote) before this can run, so a resolved job
  // reports no work. For a still-running request, the reset bumps the attempt
  // id, which is what makes the in-flight handler discard the media it is about
  // to write instead of storing it.
  useEffect(() => {
    if (gloopieCreatorEnabled || !hasGloopieGenerationWork(sessionId)) {
      return;
    }
    resetGloopieGeneration(sessionId);
  }, [gloopieCreatorEnabled, sessionId]);

  const previousGloopiePhaseRef = useRef(gloopiePhase);
  useEffect(() => {
    const previousPhase = previousGloopiePhaseRef.current;
    previousGloopiePhaseRef.current = gloopiePhase;

    if (!gloopieBackgrounded || previousPhase === gloopiePhase) {
      return;
    }

    const openGloopie = () => {
      setGloopieBackgrounded(false);
      setAvatarPanel("gloopie");
    };
    if (gloopiePhase === "choosing") {
      toast.success(t("gloopie.optionsReadyToast"), {
        action: (
          <ToastActionButton onClick={openGloopie}>
            {t("gloopie.viewOptions")}
          </ToastActionButton>
        ),
      });
    } else if (gloopiePhase === "error") {
      toast.error(t("gloopie.generationFailedToast"), {
        action: (
          <ToastActionButton onClick={openGloopie}>
            {t("gloopie.viewGeneration")}
          </ToastActionButton>
        ),
      });
    }
  }, [gloopieBackgrounded, gloopiePhase, t]);

  const personas = useAgentStore(selectPersonas);
  const takenAvatarRefCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const persona of personas) {
      if (typeof persona.avatar !== "string" || persona.avatar.length === 0) {
        continue;
      }
      counts.set(persona.avatar, (counts.get(persona.avatar) ?? 0) + 1);
    }
    return counts;
  }, [personas]);

  const defaultAvatarId =
    data && targetAgentPath && trimmedAvatar.length === 0
      ? pickDefaultAvatarId(
          avatarLibrary,
          `${sessionId}:${targetAgentPath}`,
          takenAvatarRefCounts,
        )
      : null;
  const effectiveAvatar =
    normalizedAvatar ?? (defaultAvatarId ? avatarRef(defaultAvatarId) : null);
  const selectedAvatarRefValue = effectiveAvatar
    ? parseAvatarRef(effectiveAvatar)
      ? effectiveAvatar
      : null
    : null;
  const selectedAvatarMediaState = useAvatarMediaState(effectiveAvatar);

  const onChangeProvider = useCallback(
    (next: string) => writeProperty("provider", next.length > 0 ? next : null),
    [writeProperty],
  );

  const onChangeModel = useCallback(
    (next: string) => writeProperty("model", next.length > 0 ? next : null),
    [writeProperty],
  );

  const isDraft = data?.properties?.draft === true;
  const showBackButton = Boolean(data && !isDraft && onBack);
  const hasLocalEdits =
    Boolean(data) && (saveStatus === "unsaved" || saveStatus === "error");

  useEffect(() => {
    onLocalEditStateChange?.(hasLocalEdits);

    return () => {
      onLocalEditStateChange?.(false);
    };
  }, [hasLocalEdits, onLocalEditStateChange]);

  useEffect(() => {
    if (!data) {
      onSaveDraftHandlerChange?.(null);
      return;
    }

    onSaveDraftHandlerChange?.(saveNow);
    return () => {
      onSaveDraftHandlerChange?.(null);
    };
  }, [data, onSaveDraftHandlerChange, saveNow]);

  const requiresNewDraftFields = isDraft;
  const headerName = data
    ? isPlaceholderAgentName(data.name)
      ? t("builderRail.newAgent")
      : data.name
    : isWaitingForDraftTarget
      ? t("builderRail.newAgent")
      : null;
  const nameFieldValue =
    data && !isPlaceholderAgentName(data.name) ? data.name : "";
  const contentFieldValue = data?.content ?? "";
  const isPlaceholderContent = contentFieldValue === PLACEHOLDER_AGENT_BODY;
  const instructionsFieldValue = isPlaceholderContent ? "" : contentFieldValue;
  const providerRequired = provider.trim().length > 0;
  const modelRequired = model.trim().length > 0;
  const avatarRequired = Boolean(effectiveAvatar);
  const nameRequired = nameFieldValue.trim().length > 0;
  const instructionsRequired =
    contentFieldValue.trim().length > 0 &&
    contentFieldValue !== PLACEHOLDER_AGENT_BODY;
  const missingRequiredFields = [
    requiresNewDraftFields && !avatarRequired
      ? t("builderRail.requiredAvatar")
      : null,
    !nameRequired ? t("builderRail.requiredName") : null,
    requiresNewDraftFields && !providerRequired
      ? t("builderRail.requiredProvider")
      : null,
    requiresNewDraftFields && !modelRequired
      ? t("builderRail.requiredModel")
      : null,
    requiresNewDraftFields && !instructionsRequired
      ? t("builderRail.requiredInstructions")
      : null,
  ].filter((field): field is string => field !== null);
  const blockingError =
    error !== null && !(error === "load" && saveStatus === "error");
  // An agent must never be saved with a half-finished avatar. The rule lives in
  // the store so this and the session-scoped check cannot drift; pass the gated
  // phase so a disabled experiment never blocks saving.
  const gloopieBlocksSave = isUnresolvedGloopiePhase(gloopiePhase);
  const canPromoteDraft =
    missingRequiredFields.length === 0 &&
    !gloopieBlocksSave &&
    saveStatus !== "saving" &&
    !isPromoting &&
    !blockingError;

  const showCloseButton = Boolean(
    onClose && (isWaitingForDraftTarget || (data && isDraft)),
  );

  const headerNode = (
    <div className="flex items-center justify-between py-1 text-sm text-foreground">
      <span className="flex min-w-0 items-center gap-2">
        {onExpandChat ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="-ml-1 shrink-0"
            aria-label={t("builderRail.showChat")}
            title={t("builderRail.showChat")}
            onClick={onExpandChat}
          >
            <IconLayoutSidebarLeftExpand
              className="size-4"
              aria-hidden="true"
            />
          </Button>
        ) : showBackButton && data ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="-ml-1 shrink-0"
            aria-label={t("builderRail.backToAgent")}
            onClick={() => onBack?.(data)}
          >
            <IconArrowLeft className="size-4" aria-hidden="true" />
          </Button>
        ) : null}
        <IconSparkles className="size-4 shrink-0 text-foreground" />
        {headerName ? (
          <h2 className="truncate text-sm font-normal text-foreground">
            {headerName}
          </h2>
        ) : (
          <span className="truncate">{t("builderRail.eyebrow")}</span>
        )}
      </span>
      {showCloseButton ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="-mr-1 shrink-0"
          aria-label={t("builderRail.closeBuilder")}
          tooltip={t("builderRail.closeBuilder")}
          onClick={onClose}
        >
          <IconX className="size-4" aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );

  const saveFeedbackState =
    saveStatus === "saving" || isPromoting
      ? "loading"
      : saveStatus === "error"
        ? "error"
        : "idle";

  const handleSaveChanges = useCallback(async () => {
    if (!canPromoteDraft) {
      return;
    }

    setIsPromoting(true);
    try {
      if (
        requiresNewDraftFields &&
        trimmedAvatar.length === 0 &&
        defaultAvatarId
      ) {
        update({ properties: { avatar: avatarRef(defaultAvatarId) } });
      }
      const saved = await saveNow();
      if (!saved) {
        return;
      }
      const promoted = await promoteDraft(sessionId);
      if (promoted) {
        onDraftPromoted?.(promoted);
      }
    } finally {
      setIsPromoting(false);
    }
  }, [
    canPromoteDraft,
    defaultAvatarId,
    onDraftPromoted,
    requiresNewDraftFields,
    saveNow,
    sessionId,
    trimmedAvatar.length,
    update,
  ]);

  const saveButtonUnavailable = !canPromoteDraft;
  const footerNode = data ? (
    <div className="mt-4 border-t border-border/70 pt-4">
      <Button
        type="button"
        className="w-full"
        preserveWidth
        feedbackState={saveFeedbackState}
        loadingLabel={
          isPromoting
            ? t("builderRail.creatingAgent")
            : t("builderRail.savingChanges")
        }
        errorLabel={t("builderRail.retrySave")}
        aria-disabled={saveButtonUnavailable}
        data-disabled={saveButtonUnavailable ? "true" : undefined}
        aria-describedby="agent-builder-save-help"
        onClick={() => void handleSaveChanges()}
      >
        {t("builderRail.saveChanges")}
      </Button>
      <p
        id="agent-builder-save-help"
        aria-live="polite"
        className="mt-2 text-center text-xs text-muted-foreground"
      >
        {missingRequiredFields.length > 0
          ? t("builderRail.completeRequiredFields", {
              fields: missingRequiredFields.join(", "),
            })
          : gloopieBlocksSave
            ? t(GLOOPIE_SAVE_BLOCKED_HELP_KEYS[gloopiePhase])
            : saveStatus === "unsaved"
              ? t("builderRail.unsavedChanges")
              : saveStatus === "error"
                ? t("builderRail.saveError")
                : isDraft
                  ? t("builderRail.savedHelp")
                  : t("builderRail.manualSaveHelp")}
      </p>
    </div>
  ) : null;

  const shell = (
    header: ReactNode,
    body: ReactNode,
    footer: ReactNode = null,
  ) => (
    <aside
      className={cn(
        "flex min-h-0 w-full flex-col rounded-md bg-card px-5 pb-5 pt-3",
        className,
      )}
      aria-label={t("builderRail.ariaLabel")}
      data-testid="agent-builder-rail"
      data-full-page={fullPage ? "true" : undefined}
    >
      <div className="flex min-h-0 w-full flex-1 flex-col">
        {header}
        <div className="mt-4 flex min-h-0 flex-1 flex-col">{body}</div>
        {footer}
      </div>
    </aside>
  );

  interface GloopieStatus {
    label: string;
    description: string;
    working: boolean;
    ready: boolean;
    /**
     * Visible call-to-action for states that wait on the user (options ready,
     * finished result). The whole card is one button; this renders as a
     * button-shaped affordance inside it so the card doesn't read as inert.
     */
    cta?: string;
  }

  const gloopieStatus: GloopieStatus | null = (() => {
    switch (gloopiePhase) {
      case "generating":
        return {
          label: t("gloopie.backgroundGeneratingTitle"),
          description: t("gloopie.backgroundGeneratingBody"),
          working: true,
          ready: false,
        };
      case "animating":
        return {
          label: t("gloopie.backgroundAnimatingTitle"),
          description: t("gloopie.backgroundAnimatingBody"),
          working: true,
          ready: false,
        };
      case "choosing":
        return {
          label: t("gloopie.optionsReadyToast"),
          description: t("gloopie.backgroundOptionsReadyBody"),
          working: false,
          ready: true,
          cta: t("gloopie.viewOptions"),
        };
      // No "done" case: a finished gloopie commits itself to the agent (see
      // the auto-commit effect above), so there is never a resting "ready,
      // waiting for you to accept it" card — the avatar preview simply
      // becomes the animated gloopie.
      case "error":
        return {
          label: t("gloopie.generationFailedToast"),
          description: t(gloopieErrorMessageKey(gloopieGeneration.errorCode)),
          working: false,
          ready: false,
        };
      default:
        return null;
    }
  })();

  const gloopieStatusNode = gloopieStatus ? (
    <Card className="aspect-square w-64 gap-0 border-0 bg-transparent p-0 py-0">
      <button
        type="button"
        // The takeover's funnel exit collapses toward this card, so
        // backgrounding a generation visibly lands the work here.
        data-avatar-funnel-target=""
        className="flex h-full w-full items-center justify-center rounded-md p-5 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t("gloopie.statusAria", {
          label: gloopieStatus.label,
          description: gloopieStatus.description,
        })}
        onClick={onOpenGloopieCreator}
      >
        <span className="flex flex-col items-center gap-3">
          <GloopieGenerationHero
            title={gloopieStatus.label}
            description={gloopieStatus.description}
            sampleAvatarRef={gloopieGeneration.sampleAvatarRef}
            ready={gloopieStatus.ready}
            compact
            animated={gloopieStatus.working}
          />
          {gloopieStatus.cta ? (
            // Button-shaped affordance inside the card button (the card is
            // already the interactive element, so this is presentation only).
            <span className={buttonVariants({ variant: "subtle", size: "sm" })}>
              {gloopieStatus.cta}
            </span>
          ) : null}
        </span>
      </button>
    </Card>
  ) : null;

  // Rendered by both the compact rail and the full-page builder. Declared once
  // so a prop change (e.g. gating "Create your own") cannot be applied to one
  // layout and silently missed in the other.
  const avatarLibraryPickerNode = (
    <AvatarLibraryPicker
      library={avatarLibrary}
      selectedAvatarRef={selectedAvatarRefValue}
      onSelectAvatar={onSelectAvatar}
      onPreviewError={() => {}}
      selectedCollectionId={selectedCollectionId}
      onSelectCollection={setSelectedCollectionId}
      onCreateYourOwn={gloopieCreatorEnabled ? onOpenGloopieCreator : undefined}
    />
  );

  const gloopieCreatorNode = (
    <GloopieAvatarCreator
      state={gloopieGeneration}
      onContinueSetup={onContinueGloopieSetup}
      onDiscard={onDiscardGloopie}
    />
  );

  // Full-surface takeover replacement for the inline library. Portals over
  // the entire app; the rail (and everything else) stays mounted underneath.
  // Selecting an avatar or backing out both land the user exactly where they
  // were — chat, resize state, and form drafts untouched.
  const avatarCollectionOverlayNode =
    avatarCollectionOverlayEnabled &&
    (avatarPanel === "library" || gloopieCreatorOpen) ? (
      <AvatarCollectionOverlay
        library={avatarLibrary}
        initialCollectionId={selectedCollectionId}
        // Reopening from the rail's status card lands on the step the user
        // left: the prompt (or its error) rather than the collections row.
        initialCreateOpen={gloopieCreatorOpen}
        onSelectAvatar={onSelectAvatar}
        onClose={() => {
          setSelectedCollectionId(null);
          setAvatarPanel("closed");
        }}
        gloopie={
          gloopieCreatorEnabled
            ? {
                object: gloopieGeneration.object,
                setObject: gloopieGeneration.setObject,
                start: gloopieGeneration.startGenerate,
                // Generation continues in the background; land on the rail's
                // status card and let the existing toasts announce progress.
                onHandoff: () => {
                  setSelectedCollectionId(null);
                  setGloopieBackgrounded(true);
                  setAvatarPanel("closed");
                },
                hasActiveWork: gloopiePhase !== "prompt",
                onOpenActiveWork: () => {
                  setSelectedCollectionId(null);
                  onOpenGloopieCreator();
                },
                // Choosing an avatar is one job, so generation stays on the
                // takeover: pressing "Create gloopie" keeps the glass up and
                // the four options appear in place instead of the user being
                // dropped back into the rail mid-flight.
                stayOpenWhileGenerating: true,
                generating:
                  gloopiePhase === "generating"
                    ? {
                        onContinueSetup: () => {
                          setSelectedCollectionId(null);
                          setGloopieBackgrounded(true);
                          setAvatarPanel("closed");
                        },
                        // Abandon the attempt; the takeover stays up and
                        // lands back on the prompt with the text intact.
                        onDiscard: () =>
                          gloopieGeneration.reset({ keepObject: true }),
                      }
                    : undefined,
                errorMessage:
                  gloopiePhase === "error"
                    ? t(gloopieErrorMessageKey(gloopieGeneration.errorCode))
                    : null,
                // Picking one of the four generated options happens on the
                // takeover glass, not in the rail: the user's job is still
                // "choose an avatar", so it stays on the surface that owns
                // that job. Committing a choice starts the animation and
                // hands back to the rail's status card.
                review:
                  gloopiePhase === "choosing"
                    ? {
                        options: gloopieGeneration.options,
                        chosenOptionId: gloopieGeneration.chosenOptionId,
                        chooseOption: gloopieGeneration.chooseOption,
                        animate: gloopieGeneration.animate,
                        regenerate: gloopieGeneration.regenerate,
                        startOver: () =>
                          gloopieGeneration.reset({ keepObject: true }),
                        onHandoff: () => {
                          setSelectedCollectionId(null);
                          setGloopieBackgrounded(true);
                          setAvatarPanel("closed");
                        },
                      }
                    : undefined,
                animating:
                  gloopiePhase === "animating"
                    ? {
                        onContinueSetup: () => {
                          setSelectedCollectionId(null);
                          setGloopieBackgrounded(true);
                          setAvatarPanel("closed");
                        },
                        // Abandon the attempt; the takeover stays up and
                        // lands back on the prompt with the text intact.
                        onDiscard: () =>
                          gloopieGeneration.reset({ keepObject: true }),
                      }
                    : undefined,
                // No done step: a finished gloopie auto-commits to the agent
                // (see the effect above), so the takeover never has to host a
                // "use it or start over" review.
              }
            : undefined
        }
      />
    ) : null;

  const pickerHeaderNode = (
    <div className="flex items-center gap-2 py-3 text-sm text-foreground">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t("builderRail.backToForm")}
        onClick={() => {
          if (gloopieCreatorOpen) {
            if (gloopiePhase === "prompt") {
              setAvatarPanel("library");
            } else {
              setGloopieBackgrounded(true);
              setAvatarPanel("closed");
            }
          } else if (selectedCollectionId) {
            setSelectedCollectionId(null);
          } else {
            setAvatarPanel("closed");
          }
        }}
      >
        <IconArrowLeft className="size-4" aria-hidden="true" />
      </Button>
      <h2 className="truncate text-sm font-normal text-foreground">
        {gloopieCreatorOpen
          ? gloopiePhase === "prompt"
            ? t("gloopie.title")
            : t("gloopie.continueAgentSetup")
          : selectedCollection
            ? selectedCollection.label
            : t("builderRail.chooseAvatarTitle")}
      </h2>
    </div>
  );

  if (error === "parse") {
    return shell(
      headerNode,
      <section className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
        <div className="flex items-start gap-2">
          <IconAlertTriangle className="mt-0.5 size-4 text-destructive" />
          <div>
            <h3 className="text-sm font-normal text-foreground">
              {t("builderRail.invalidFrontmatterTitle")}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("builderRail.invalidFrontmatterBody")}
            </p>
          </div>
        </div>
      </section>,
    );
  }

  if (isWaitingForDraftTarget) {
    return shell(
      headerNode,
      draftState === "failed" ? (
        <section className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
          <div className="flex items-start gap-2">
            <IconAlertTriangle className="mt-0.5 size-4 text-destructive" />
            <div>
              <h3 className="text-sm font-normal text-foreground">
                {t("builderRail.prepareDraftFailedTitle")}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("builderRail.prepareDraftFailedBody")}
              </p>
              {onRecoverMissingDraft ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => void onRecoverMissingDraft()}
                >
                  {t("builderRail.retryPrepareDraft")}
                </Button>
              ) : null}
            </div>
          </div>
        </section>
      ) : (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          <span>{t("builderRail.preparingDraft")}</span>
        </div>
      ),
    );
  }

  if ((isLoading && !data) || isRecoveringMissingDraft) {
    return shell(
      headerNode,
      <p className="text-sm text-muted-foreground">
        {t("builderRail.loading")}
      </p>,
    );
  }

  if (error === "missing" || !data) {
    return shell(
      headerNode,
      <section className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
        <div className="flex items-start gap-2">
          <IconAlertTriangle className="mt-0.5 size-4 text-destructive" />
          <div>
            <h3 className="text-sm font-normal text-foreground">
              {t("builderRail.draftMissingTitle")}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("builderRail.draftMissingBody")}
            </p>
            {onRecoverMissingDraft ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={onRecoverMissingDraft}
              >
                {t("builderRail.startFreshDraft")}
              </Button>
            ) : null}
          </div>
        </div>
      </section>,
    );
  }

  // With the collection canvas on, every gloopie step lives on the takeover
  // (mounted below), so the rail keeps showing the form + status card instead
  // of duplicating the flow in its body.
  if (gloopieCreatorOpen && !fullPage && !avatarCollectionOverlayEnabled) {
    return shell(pickerHeaderNode, gloopieCreatorNode);
  }

  // With the collection canvas experiment on, the "library" panel renders as
  // the full-surface overlay (mounted below) instead of swapping the rail
  // body, so the form stays visible underneath the frosted glass.
  if (
    avatarPanel === "library" &&
    !fullPage &&
    !avatarCollectionOverlayEnabled
  ) {
    return shell(pickerHeaderNode, avatarLibraryPickerNode, gloopieStatusNode);
  }

  const avatarNode = gloopieStatusNode ? (
    <section className="flex min-h-72 w-full items-center justify-center py-4">
      <div role="status" aria-live="polite">
        {gloopieStatusNode}
      </div>
    </section>
  ) : (
    <section>
      <button
        type="button"
        // The takeover's funnel exit collapses toward this preview, so
        // selecting an avatar visibly lands it here.
        data-avatar-funnel-target=""
        className={cn(
          "group relative flex min-h-48 w-full items-center justify-center overflow-hidden rounded-md bg-card/40 p-5 transition-colors hover:bg-card/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          fullPage && "min-h-[20rem]",
        )}
        aria-label={
          normalizedAvatar
            ? t("builderRail.changeAvatar")
            : t("builderRail.selectAvatar")
        }
        onClick={() => setAvatarPanel("library")}
      >
        {/* `relative` so the hover label anchors to the avatar box rather than
            to the full-width button, where it drifted into the far corner. */}
        <div
          className={cn(
            "relative flex size-40 shrink-0 items-center justify-center overflow-hidden",
            fullPage && "size-56",
          )}
        >
          {selectedAvatarMediaState.media ? (
            <AvatarMedia
              media={selectedAvatarMediaState.media}
              alt={t("avatar.previewAlt")}
              className="h-full w-full object-contain"
            />
          ) : selectedAvatarMediaState.loading ? (
            <Spinner className="size-4 text-muted-foreground" />
          ) : (
            <IconPhoto
              className="size-10 text-muted-foreground"
              aria-hidden="true"
            />
          )}
          {/* Centered on the avatar: the media is `object-contain`, so a
              corner-anchored label sits over transparent padding and reads as
              detached for tall or wide avatars alike. */}
          <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-foreground px-3 py-1.5 text-xs text-background opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            {normalizedAvatar
              ? t("builderRail.changeAvatar")
              : t("builderRail.selectAvatar")}
          </span>
        </div>
      </button>
    </section>
  );

  const fieldsNode = (
    <>
      <label className="block text-sm" htmlFor="builder-rail-name">
        <span className={FIELD_LABEL_CLASS}>{t("editor.displayName")}</span>
        <Input
          id="builder-rail-name"
          value={nameFieldValue}
          placeholder={t("editor.displayNamePlaceholder")}
          onChange={(event) => update({ name: event.target.value })}
          className={FIELD_CLASS}
        />
      </label>

      <ProviderModelFields
        provider={provider}
        model={model}
        onProviderChange={onChangeProvider}
        onModelChange={onChangeModel}
        builderSessionId={sessionId}
        classes={{
          fieldLabel: FIELD_LABEL_CLASS,
          selectTrigger: FIELD_CLASS,
        }}
      />

      <label
        className="flex min-h-0 flex-1 flex-col text-sm"
        htmlFor="builder-rail-instructions"
      >
        <span className={FIELD_LABEL_CLASS}>
          {t("builderRail.instructionsLabel")}
        </span>
        <Textarea
          id="builder-rail-instructions"
          value={instructionsFieldValue}
          placeholder={
            isPlaceholderContent
              ? PLACEHOLDER_AGENT_BODY
              : t("builderRail.instructionsPlaceholder")
          }
          onChange={(event) => update({ content: event.target.value })}
          rows={fullPage ? undefined : 8}
          className={cn(
            FIELD_CLASS,
            "min-h-32",
            fullPage ? "flex-1 resize-none" : "resize-y",
          )}
        />
      </label>

      {error === "load" ? (
        <section
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3"
        >
          <div className="flex items-start gap-2">
            <IconAlertTriangle className="mt-0.5 size-4 text-destructive" />
            <div>
              <h3 className="text-sm font-normal text-foreground">
                {t("builderRail.saveFailedTitle")}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("builderRail.saveFailedBody")}
              </p>
            </div>
          </div>
        </section>
      ) : null}
    </>
  );

  const fullPageShowsGloopie =
    !avatarCollectionOverlayEnabled &&
    (gloopieCreatorOpen || gloopieStatus !== null);
  const fullPageLeftColumn = fullPageShowsGloopie ? (
    <div className="flex min-h-0 flex-1 flex-col">
      {gloopiePhase === "prompt" ? (
        <div className="flex items-center gap-2 px-6 pt-4 text-sm text-foreground xl:px-10 xl:pt-6">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="-ml-1 shrink-0"
            aria-label={t("gloopie.backToAvatarChoices")}
            onClick={() => setAvatarPanel("library")}
          >
            <IconArrowLeft className="size-4" aria-hidden="true" />
          </Button>
          <h3 className="truncate text-sm font-normal text-foreground">
            {t("gloopie.title")}
          </h3>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 justify-center px-6 py-4 xl:px-10 xl:py-6">
        <div className="flex min-h-0 w-full max-w-xl flex-col">
          {gloopieCreatorNode}
        </div>
      </div>
    </div>
  ) : avatarPanel === "library" && !avatarCollectionOverlayEnabled ? (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-8 py-6 xl:px-12 xl:py-8">
      <div className="flex items-center gap-2 text-sm text-foreground">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="-ml-1 shrink-0"
          aria-label={t("builderRail.backToForm")}
          onClick={() => {
            if (selectedCollectionId) {
              setSelectedCollectionId(null);
            } else {
              setAvatarPanel("closed");
            }
          }}
        >
          <IconArrowLeft className="size-4" aria-hidden="true" />
        </Button>
        <h3 className="truncate text-sm font-normal text-foreground">
          {selectedCollection
            ? selectedCollection.label
            : t("builderRail.chooseAvatarTitle")}
        </h3>
      </div>
      {avatarLibraryPickerNode}
    </div>
  ) : (
    <div className="flex flex-col">{avatarNode}</div>
  );

  if (fullPage) {
    return (
      <>
        {shell(
          headerNode,
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(24rem,1fr)_minmax(24rem,1fr)] gap-10">
            <div className="flex min-h-0 flex-col">{fullPageLeftColumn}</div>
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4 py-6 xl:px-8 xl:py-8">
              {fieldsNode}
            </div>
          </div>,
          footerNode,
        )}
        {avatarCollectionOverlayNode}
      </>
    );
  }

  return (
    <>
      {shell(
        headerNode,
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          {avatarNode}
          {fieldsNode}
        </div>,
        footerNode,
      )}
      {avatarCollectionOverlayNode}
    </>
  );
}

function pickDefaultAvatarId(
  library: AvatarLibraryState,
  seed: string,
  takenAvatarRefCounts: Map<string, number>,
): string | null {
  const catalog = library.catalog;
  if (!catalog || catalog.assets.length === 0) {
    return null;
  }

  const cachedIds = Object.entries(library.cachedAvatarMediaById)
    .filter(([, entry]) => entry.catalogVersion === catalog.catalogVersion)
    .map(([avatarId]) => avatarId)
    .filter((avatarId) =>
      catalog.assets.some((entry) => entry.id === avatarId),
    );
  const candidateIds =
    cachedIds.length > 0
      ? cachedIds
      : catalog.collections.length > 0
        ? catalog.collections.map((collection) => collection.coverAvatarId)
        : catalog.assets.map((entry) => entry.id);

  if (candidateIds.length === 0) {
    return null;
  }

  // Prefer avatars not in use by any persona; fall back to least-used.
  // Final tiebreak is the deterministic seed hash so picks are stable per draft.
  let minCount = Number.POSITIVE_INFINITY;
  for (const id of candidateIds) {
    const count = takenAvatarRefCounts.get(avatarRef(id)) ?? 0;
    if (count < minCount) {
      minCount = count;
    }
  }
  const leastUsedIds = candidateIds.filter(
    (id) => (takenAvatarRefCounts.get(avatarRef(id)) ?? 0) === minCount,
  );

  return leastUsedIds[stableHash(seed) % leastUsedIds.length] ?? null;
}

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
