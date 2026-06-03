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
  IconArrowLeft,
  IconPhoto,
  IconSparkles,
  IconTrash,
} from "@tabler/icons-react";
import { avatarRef, parseAvatarRef } from "@/shared/avatars/catalog";
import { normalizeAvatarUrl } from "@/shared/lib/avatarUrl";
import { cn } from "@/shared/lib/cn";
import type { AgentSourceEntry } from "@/shared/api/agents";
import { useAvatarMediaState } from "@/shared/hooks/useAvatarSrc";
import { Button } from "@/shared/ui/button";
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
  discardDraftAgentSession,
  fileStem,
  isPlaceholderAgentName,
  PLACEHOLDER_AGENT_BODY,
  promoteDraft,
} from "@/features/agents/lib/agentBuilderSession";
import { AvatarLibraryPicker } from "@/features/agents/ui/AvatarLibraryPicker";
import { ProviderModelFields } from "@/features/agents/ui/PersonaFields/ProviderModelFields";
import { FORM_FIELD_CLASS } from "@/shared/ui/form-field-tokens";

const FIELD_CLASS = FORM_FIELD_CLASS;
const FIELD_LABEL_CLASS = "mb-2 block text-xs text-muted-foreground";

export interface AgentBuilderRailProps {
  sessionId: string;
  targetAgentPath: string;
  /** Reserved for future deep-linking / re-binding by slug; not used in v1 render. */
  targetAgentSlug: string;
  className?: string;
  onDraftPromoted?: (source: AgentSourceEntry) => void;
  onDraftTargetChanged?: (target: { path: string; slug: string }) => void;
  onRecoverMissingDraft?: () => void | Promise<void>;
}

export function AgentBuilderRail({
  sessionId,
  targetAgentPath,
  className,
  onDraftPromoted,
  onDraftTargetChanged,
  onRecoverMissingDraft,
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
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [recoveringMissingDraftKey, setRecoveringMissingDraftKey] = useState<
    string | null
  >(null);
  const [failedMissingDraftRecoveryKey, setFailedMissingDraftRecoveryKey] =
    useState<string | null>(null);
  const avatarLibrary = useAvatarLibrary(true);
  const missingDraftRecoveryKey = `${sessionId}:${targetAgentPath}`;
  const shouldRecoverMissingDraft =
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

  useEffect(() => {
    void missingDraftRecoveryKey;
    setRecoveringMissingDraftKey(null);
    setFailedMissingDraftRecoveryKey(null);
  }, [missingDraftRecoveryKey]);

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
      setAvatarPickerOpen(false);
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
    data && trimmedAvatar.length === 0
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
  const requiresNewDraftFields = isDraft;
  const headerName = data
    ? isPlaceholderAgentName(data.name)
      ? t("builderRail.newAgent")
      : data.name
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
  const canPromoteDraft =
    missingRequiredFields.length === 0 &&
    saveStatus !== "saving" &&
    !isPromoting &&
    !blockingError;

  const headerNode = (
    <div className="flex items-center justify-between rounded-full bg-card/40 px-4 py-3 text-sm text-foreground">
      <span className="flex min-w-0 items-center gap-2">
        <IconSparkles className="size-4 shrink-0 text-foreground" />
        {headerName ? (
          <h2 className="truncate text-sm font-normal text-foreground">
            {headerName}
          </h2>
        ) : (
          <span className="truncate">{t("builderRail.eyebrow")}</span>
        )}
      </span>
      {data && isDraft ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => {
            void discardDraftAgentSession(sessionId);
          }}
        >
          <IconTrash className="size-3.5" aria-hidden="true" />
          {t("builderRail.discard")}
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
        disabled={!canPromoteDraft}
        onClick={() => void handleSaveChanges()}
      >
        {t("builderRail.saveChanges")}
      </Button>
      <p className="mt-2 text-center text-[11px] text-muted-foreground">
        {missingRequiredFields.length > 0
          ? t("builderRail.completeRequiredFields", {
              fields: missingRequiredFields.join(", "),
            })
          : saveStatus === "unsaved"
            ? t("builderRail.unsavedChanges")
            : saveStatus === "error"
              ? t("builderRail.saveError")
              : t("builderRail.savedHelp")}
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
        "flex min-h-0 w-full flex-col rounded-md bg-card p-5 lg:w-[506px]",
        className,
      )}
      aria-label={t("builderRail.ariaLabel")}
      data-testid="agent-builder-rail"
    >
      {header}
      <div className="mt-5 min-h-0 flex-1 space-y-4 overflow-y-auto">
        {body}
      </div>
      {footer}
    </aside>
  );

  const pickerHeaderNode = (
    <div className="flex items-center gap-2 rounded-full bg-card/40 px-3 py-3 text-sm text-foreground">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t("builderRail.backToForm")}
        onClick={() => {
          if (selectedCollectionId) {
            setSelectedCollectionId(null);
          } else {
            setAvatarPickerOpen(false);
          }
        }}
      >
        <IconArrowLeft className="size-4" aria-hidden="true" />
      </Button>
      <h2 className="truncate text-sm font-normal text-foreground">
        {selectedCollection
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

  if (avatarPickerOpen) {
    return shell(
      pickerHeaderNode,
      <AvatarLibraryPicker
        library={avatarLibrary}
        selectedAvatarRef={selectedAvatarRefValue}
        onSelectAvatar={onSelectAvatar}
        onPreviewError={() => {}}
        selectedCollectionId={selectedCollectionId}
        onSelectCollection={setSelectedCollectionId}
      />,
    );
  }

  return shell(
    headerNode,
    <>
      <section>
        <button
          type="button"
          className="group relative flex min-h-48 w-full items-center justify-center overflow-hidden rounded-md bg-card/40 p-5 transition-colors hover:bg-card/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={
            normalizedAvatar
              ? t("builderRail.changeAvatar")
              : t("builderRail.selectAvatar")
          }
          onClick={() => setAvatarPickerOpen(true)}
        >
          <div className="flex size-40 shrink-0 items-center justify-center overflow-hidden">
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
          </div>
          <span className="absolute right-3 top-3 rounded-full bg-foreground px-3 py-1.5 text-xs text-background opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            {normalizedAvatar
              ? t("builderRail.changeAvatar")
              : t("builderRail.selectAvatar")}
          </span>
        </button>
      </section>

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

      <label className="block text-sm" htmlFor="builder-rail-instructions">
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
          rows={8}
          className={cn(FIELD_CLASS, "min-h-32 resize-y")}
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
    </>,
    footerNode,
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
