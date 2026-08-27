import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  IconAlertTriangle,
  IconLayoutSidebarLeftExpand,
  IconPhoto,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";
import { avatarRef } from "@/shared/avatars/catalog";
import { normalizeAvatarUrl } from "@/shared/lib/avatarUrl";
import { cn } from "@/shared/lib/cn";
import type { AgentSourceEntry } from "@/shared/api/agents";
import { useAvatarMediaState } from "@/shared/hooks/useAvatarSrc";
import { Button, buttonVariants } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { Spinner } from "@/shared/ui/spinner";
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
  trackAgentCreateCompleted,
  trackAgentEditCompleted,
} from "@/features/agents/lib/agentTelemetry";
import {
  fileStem,
  isPlaceholderAgentName,
  PLACEHOLDER_AGENT_BODY,
  promoteDraft,
} from "@/features/agents/lib/agentBuilderSession";
import { AvatarCollectionOverlay } from "@/features/agents/ui/AvatarCollectionOverlay";
import { ProviderModelFields } from "@/features/agents/ui/PersonaFields/ProviderModelFields";
import { FORM_FIELD_CLASS } from "@/shared/ui/form-field-tokens";
import { hasRealAgentDescription } from "@/shared/api/agents";

const FIELD_CLASS = cn(FORM_FIELD_CLASS, "bg-muted/40");
const FIELD_LABEL_CLASS = "mb-2 block text-xs text-muted-foreground";
const STICKY_HEADER_CLASS =
  "relative z-10 bg-card px-8 py-4 text-sm text-foreground after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-6 after:bg-gradient-to-b after:from-card after:to-transparent";

/**
 * Design width of the builder rail. Containers that host the rail should size
 * their column from this constant so the rail is never clipped.
 */
export const AGENT_BUILDER_RAIL_WIDTH = 506;

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
  // Edit Completed is anchored to the persisted write itself: every saveNow
  // entry point (the Save button, the leave-builder "Keep" save, closing the
  // builder) funnels through the same flush, a no-op save never persists
  // anything, and the event must not depend on the post-save promoteDraft
  // lookup succeeding. Draft writes are the create flow's incremental saves;
  // creation is tracked once, on the confirmed promote.
  const handleWritePersisted = useCallback((source: AgentSourceEntry) => {
    if (source.properties?.draft === true) {
      return;
    }
    trackAgentEditCompleted({
      provider: source.properties?.provider,
      model: source.properties?.model,
    });
  }, []);
  const { data, isLoading, error, update, saveStatus, saveNow } =
    usePersonaSource(targetAgentPath, {
      builderSessionId: sessionId,
      onResolvedPathChange: handleResolvedPathChange,
      onWritePersisted: handleWritePersisted,
    });
  const [isPromoting, setIsPromoting] = useState(false);
  const saveAttemptKey = `${sessionId}:${targetAgentPath ?? "pending"}`;
  const [attemptedSaveKey, setAttemptedSaveKey] = useState<string | null>(null);
  const [avatarPanel, setAvatarPanel] = useState<"closed" | "library">(
    "closed",
  );
  const [recoveringMissingDraftKey, setRecoveringMissingDraftKey] = useState<
    string | null
  >(null);
  const [failedMissingDraftRecoveryKey, setFailedMissingDraftRecoveryKey] =
    useState<string | null>(null);
  const avatarLibrary = useAvatarLibrary(true);
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
  const provider = (data?.properties?.provider as string | undefined) ?? "";
  const modelProviderId =
    (data?.properties?.modelProviderId as string | undefined) ?? "";
  const model = (data?.properties?.model as string | undefined) ?? "";

  const writeProperties = useCallback(
    (properties: PersonaSourcePatch["properties"]) => {
      update({ properties });
    },
    [update],
  );
  const writeProperty = useCallback(
    (
      key: "provider" | "modelProviderId" | "model" | "avatar",
      value: string | null,
    ) => writeProperties({ [key]: value }),
    [writeProperties],
  );

  const onSelectAvatar = useCallback(
    (selectedAvatarRef: string) => {
      // Avatar selection joins the same working buffer as every other field.
      // Existing-agent edits stay local until Save; drafts keep their normal
      // debounced durability rather than making this field a separate commit.
      writeProperty("avatar", selectedAvatarRef);
    },
    [writeProperty],
  );

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
  const selectedAvatarMediaState = useAvatarMediaState(effectiveAvatar);

  const onChangeProvider = useCallback(
    (next: string) =>
      writeProperties({
        provider: next.length > 0 ? next : null,
        modelProviderId: null,
        model: null,
      }),
    [writeProperties],
  );

  const onChangeModel = useCallback(
    (
      selection: {
        modelId: string;
        modelProviderId: string;
      } | null,
    ) =>
      writeProperties({
        modelProviderId: selection?.modelProviderId ?? null,
        model: selection?.modelId ?? null,
      }),
    [writeProperties],
  );

  const isDraft = data?.properties?.draft === true;
  const hasLocalEdits =
    Boolean(data) && (saveStatus === "unsaved" || saveStatus === "error");

  useEffect(() => {
    onLocalEditStateChange?.(hasLocalEdits);

    return () => {
      onLocalEditStateChange?.(false);
    };
  }, [hasLocalEdits, onLocalEditStateChange]);

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
  const descriptionFieldValue =
    data && hasRealAgentDescription(data.description) ? data.description : "";
  const contentFieldValue = data?.content ?? "";
  const isPlaceholderContent = contentFieldValue === PLACEHOLDER_AGENT_BODY;
  const instructionsFieldValue = isPlaceholderContent ? "" : contentFieldValue;
  const avatarRequired = Boolean(effectiveAvatar);
  const nameRequired = nameFieldValue.trim().length > 0;
  const descriptionRequired = descriptionFieldValue.trim().length > 0;
  const instructionsRequired =
    contentFieldValue.trim().length > 0 &&
    contentFieldValue !== PLACEHOLDER_AGENT_BODY;
  const missingRequiredFields = [
    requiresNewDraftFields && !avatarRequired
      ? { label: t("builderRail.requiredAvatar"), blocksSaveAttempt: true }
      : null,
    !nameRequired
      ? { label: t("builderRail.requiredName"), blocksSaveAttempt: true }
      : null,
    !descriptionRequired
      ? {
          label: t("builderRail.requiredDescription"),
          blocksSaveAttempt: false,
        }
      : null,
    requiresNewDraftFields && !instructionsRequired
      ? {
          label: t("builderRail.requiredInstructions"),
          blocksSaveAttempt: true,
        }
      : null,
  ].filter((field) => field !== null);
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

  const blockingError =
    error !== null && !(error === "load" && saveStatus === "error");
  // An agent must never be saved with a half-finished avatar. The rule lives in
  // the store so this and the session-scoped check cannot drift; pass the gated
  // phase so a disabled experiment never blocks saving.
  const canPromoteDraft =
    missingRequiredFields.length === 0 &&
    saveStatus !== "saving" &&
    !isPromoting &&
    !blockingError;

  const showCloseButton = Boolean(
    onClose && (isWaitingForDraftTarget || (data && isDraft)),
  );

  const headerNode = (
    <div
      className={cn(STICKY_HEADER_CLASS, "flex items-center justify-between")}
    >
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
    setAttemptedSaveKey(saveAttemptKey);
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
        if (requiresNewDraftFields) {
          // Create Completed on confirmed promote success. The promoted
          // source is authoritative: its properties carry the configured
          // provider/model. Edits are not tracked here — Edit Completed rides
          // the persisted write (handleWritePersisted), which a no-op save
          // never reaches and a failed post-save lookup cannot lose.
          trackAgentCreateCompleted({
            provider: promoted.properties?.provider,
            model: promoted.properties?.model,
          });
        }
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
    saveAttemptKey,
    saveNow,
    sessionId,
    trimmedAvatar.length,
    update,
  ]);

  const saveButtonUnavailable =
    missingRequiredFields.some((field) => field.blocksSaveAttempt) ||
    saveStatus === "saving" ||
    isPromoting ||
    blockingError;
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
              fields: missingRequiredFields
                .map((field) => field.label)
                .join(", "),
            })
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
        "flex min-h-0 w-full flex-col overflow-hidden rounded-md bg-card pb-5",
        className,
      )}
      aria-label={t("builderRail.ariaLabel")}
      data-testid="agent-builder-rail"
      data-full-page={fullPage ? "true" : undefined}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="sticky top-0 z-10">{header}</div>
        <div className="mt-4 flex min-h-0 flex-1 flex-col px-5">{body}</div>
      </div>
      {footer ? <div className="px-5">{footer}</div> : null}
    </aside>
  );

  const avatarCollectionOverlayNode =
    avatarPanel === "library" ? (
      <AvatarCollectionOverlay
        library={avatarLibrary}
        onSelectAvatar={onSelectAvatar}
        onClose={() => setAvatarPanel("closed")}
      />
    ) : null;

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

  const avatarNode = (
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
          {/* Black pill (design feedback): matches the takeover's primary
            nav controls. Presentation only — the surrounding button is the
            interactive element. */}
          <span
            className={cn(
              buttonVariants({ variant: "primary", size: "sm" }),
              "pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
            )}
          >
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

      <label className="block text-sm" htmlFor="builder-rail-description">
        <span className={FIELD_LABEL_CLASS}>
          {t("builderRail.descriptionLabel")}
        </span>
        <Input
          id="builder-rail-description"
          value={descriptionFieldValue}
          required
          aria-invalid={
            attemptedSaveKey === saveAttemptKey && !descriptionRequired
          }
          placeholder={t("builderRail.descriptionPlaceholder")}
          onChange={(event) => update({ description: event.target.value })}
          className={FIELD_CLASS}
        />
      </label>

      <ProviderModelFields
        provider={provider}
        modelProviderId={modelProviderId}
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
            "agent-builder-instructions-scrollbar min-h-32 overflow-y-scroll scrollbar-visible [scrollbar-gutter:stable]",
            fullPage
              ? "flex-1 resize-none"
              : "max-h-[min(20rem,calc(100vh-24rem))] resize-y",
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

  const fullPageLeftColumn = <div className="flex flex-col">{avatarNode}</div>;

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
        <div className="flex flex-col gap-4">
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
