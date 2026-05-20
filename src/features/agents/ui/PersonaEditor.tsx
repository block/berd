import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Check, Copy, Trash2 } from "lucide-react";
import {
  avatarCollections,
  avatarRef,
  getAvatarCatalogEntry,
  isBundledAvatarRef,
} from "@/shared/avatars/catalog";
import type {
  AvatarCatalogEntry,
  AvatarCollection,
} from "@/shared/avatars/catalog";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Textarea } from "@/shared/ui/textarea";
import { Sheet, SheetContent, SheetTitle } from "@/shared/ui/sheet";
import { normalizeAvatarUrl } from "@/shared/lib/avatarUrl";
import { useAvatarMedia } from "@/shared/hooks/useAvatarSrc";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import type { Persona, ProviderType } from "@/shared/types/agents";
import type {
  CreatePersonaRequest,
  UpdatePersonaRequest,
} from "@/shared/types/agents";
import { discoverAcpProviders } from "@/shared/api/acp";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useProviderInventory } from "@/features/providers/hooks/useProviderInventory";
import { getProviderInventory } from "@/features/providers/api/inventory";
import { useProviderInventoryStore } from "@/features/providers/stores/providerInventoryStore";
import {
  canEditPersona,
  getPersonaSource,
} from "@/features/agents/lib/personaPresentation";
import { resolveAgentIcon } from "@/features/agents/lib/resolveAgentIcon";

interface PersonaEditorProps {
  persona?: Persona;
  isOpen: boolean;
  mode?: "create" | "edit" | "details";
  onClose: () => void;
  onSave: (data: CreatePersonaRequest | UpdatePersonaRequest) => void;
  onDuplicate?: (persona: Persona) => void;
  onEdit?: (persona: Persona) => void;
  onDelete?: (persona: Persona) => void;
  isPending?: boolean;
}

// Shared visual constants for create/edit sheets. Mirrored in SkillEditor —
// extract to a shared primitive once a third surface adopts the IA.
const SHEET_CONTENT_CLASS = "flex h-full flex-col gap-0 p-0 sm:max-w-[440px]";
const HERO_HEIGHT_CLASS = "h-[280px]";
const PILL_INPUT_CLASS =
  "h-10 rounded-full border-none bg-surface-overlay px-4 text-sm";
const FIELD_INPUT_CLASS =
  "h-10 rounded-[10px] border-none bg-surface-overlay px-4 text-sm";
const TEXTAREA_FIELD_CLASS =
  "min-h-[120px] resize-none rounded-[10px] border-none bg-surface-overlay px-4 py-3 text-sm";
const FIELD_LABEL_CLASS = "text-[10px] text-muted-foreground";
const SECTION_GAP_CLASS = "space-y-1";

export function PersonaEditor({
  persona,
  isOpen,
  mode = "create",
  onClose,
  onSave,
  onDuplicate,
  onEdit: _onEdit,
  onDelete,
  isPending = false,
}: PersonaEditorProps) {
  const { t } = useTranslation(["agents", "common"]);
  const isEditing = mode === "edit";
  const detailsMode = mode === "details";
  const readOnlyBySource = persona ? !canEditPersona(persona) : false;
  const isReadOnly = detailsMode || readOnlyBySource;
  const personaSource = persona ? getPersonaSource(persona) : null;
  const isBuiltIn = personaSource === "builtin";
  const acpProviders = useAgentStore((s) => s.providers);
  const setProviders = useAgentStore((s) => s.setProviders);
  const mergeInventoryEntries = useProviderInventoryStore(
    (s) => s.mergeEntries,
  );
  const { getEntry, getModelsForAgent } = useProviderInventory();

  const [displayName, setDisplayName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [provider, setProvider] = useState<ProviderType | "">("");
  const [model, setModel] = useState("");
  const [avatarValue, setAvatarValue] = useState("");
  const [avatarChanged, setAvatarChanged] = useState(false);
  const [selectedAvatarCollectionId, setSelectedAvatarCollectionId] = useState<
    string | null
  >(null);
  const [avatarPreviewFailed, setAvatarPreviewFailed] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let cancelled = false;

    const syncProviderOptions = async () => {
      try {
        const providers = await discoverAcpProviders();
        if (!cancelled) {
          setProviders(providers);
        }
      } catch (error) {
        console.warn("Failed to load ACP providers for persona editor:", error);
      }

      try {
        const entries = await getProviderInventory();
        if (!cancelled) {
          mergeInventoryEntries(entries);
        }
      } catch (error) {
        console.warn(
          "Failed to load provider inventory for persona editor:",
          error,
        );
      }
    };

    void syncProviderOptions();

    return () => {
      cancelled = true;
    };
  }, [isOpen, mergeInventoryEntries, setProviders]);

  useEffect(() => {
    if (isOpen && persona) {
      setDisplayName(persona.displayName);
      setSystemPrompt(persona.systemPrompt);
      setProvider(persona.provider ?? "");
      setModel(persona.model ?? "");
      setAvatarValue(normalizeAvatarUrl(persona.avatar) ?? "");
    } else if (isOpen) {
      setDisplayName("");
      setSystemPrompt("");
      setProvider("");
      setModel("");
      setAvatarValue("");
    }
    setAvatarChanged(false);
    setSelectedAvatarCollectionId(null);
    setAvatarPreviewFailed(false);
  }, [isOpen, persona]);

  const trimmedAvatarValue = avatarValue.trim();
  const normalizedAvatarValue = normalizeAvatarUrl(trimmedAvatarValue);
  const customAvatarUrlValue = isBundledAvatarRef(trimmedAvatarValue)
    ? ""
    : avatarValue;
  const avatarUrlError =
    trimmedAvatarValue.length > 0 && !normalizedAvatarValue
      ? t("editor.avatarUrlInvalid")
      : null;
  const avatarMedia = useAvatarMedia(normalizedAvatarValue ?? null);
  const selectedAvatarCollection = avatarCollections.find(
    (collection) => collection.id === selectedAvatarCollectionId,
  );

  const isValid =
    displayName.trim().length > 0 &&
    systemPrompt.trim().length > 0 &&
    !avatarUrlError;

  const availableModels = provider ? getModelsForAgent(provider) : [];
  const providerInventory = provider ? getEntry(provider) : undefined;
  const modelStatusMessage =
    providerInventory?.modelSelectionHint ??
    providerInventory?.lastRefreshError;
  const hasSavedModelOutsideInventory =
    Boolean(model) && !availableModels.some((entry) => entry.id === model);
  const modelSelectValue = hasSavedModelOutsideInventory
    ? `__saved__:${model}`
    : model || "__none__";

  const readOnlyDescription = readOnlyBySource
    ? isBuiltIn
      ? t("editor.readOnlyBuiltIn")
      : t("editor.readOnlyFile")
    : null;

  const fallbackAvatarSrc = resolveAgentIcon(persona?.id ?? "new");

  const handleClearAvatar = useCallback(() => {
    setAvatarValue("");
    setAvatarChanged(true);
    setAvatarPreviewFailed(false);
  }, []);

  const handleAvatarUrlChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setAvatarValue(event.target.value);
      setAvatarChanged(true);
      setAvatarPreviewFailed(false);
    },
    [],
  );

  const handleSelectAvatar = useCallback((avatarId: string) => {
    setAvatarValue(avatarRef(avatarId));
    setAvatarChanged(true);
    setAvatarPreviewFailed(false);
  }, []);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!isValid || isReadOnly) return;

      // Update requests use null to clear source properties; undefined leaves them unchanged.
      const data: CreatePersonaRequest | UpdatePersonaRequest = {
        displayName: displayName.trim(),
        systemPrompt: systemPrompt.trim(),
        provider: provider || (isEditing ? null : undefined),
        model: model.trim() || (isEditing ? null : undefined),
        avatar: isEditing
          ? avatarChanged
            ? (normalizedAvatarValue ?? null)
            : undefined
          : (normalizedAvatarValue ?? undefined),
      };
      onSave(data);
    },
    [
      isValid,
      isReadOnly,
      isEditing,
      displayName,
      systemPrompt,
      provider,
      model,
      avatarChanged,
      normalizedAvatarValue,
      onSave,
    ],
  );

  const titleText = detailsMode
    ? (persona?.displayName ?? "")
    : isEditing
      ? (persona?.displayName ?? t("editor.editTitle"))
      : t("editor.newTitle");

  const renderAvatarTile = (entry: AvatarCatalogEntry) => {
    const ref = avatarRef(entry.id);
    const selected = normalizedAvatarValue === ref;

    return (
      <button
        key={entry.id}
        type="button"
        className={cn(
          "relative flex aspect-square min-h-24 items-center justify-center overflow-hidden rounded-card-sm bg-surface-overlay p-2",
          "border border-border-soft transition-colors hover:border-border",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-focus",
          selected && "border-border-focus ring-2 ring-ring-focus/25",
        )}
        aria-label={entry.label}
        aria-pressed={selected}
        onClick={() => handleSelectAvatar(entry.id)}
      >
        <AvatarMedia
          media={{ src: entry.src, mediaType: entry.mediaType }}
          alt=""
          lazy
          className="max-h-full max-w-full object-contain"
        />
        {selected ? (
          <span className="absolute right-2 top-2 flex size-5 items-center justify-center rounded-full bg-background-primary text-text-on-primary">
            <Check className="size-3" />
          </span>
        ) : null}
      </button>
    );
  };

  const renderCollectionButton = (collection: AvatarCollection) => {
    const cover = getAvatarCatalogEntry(collection.coverAvatarId);
    if (!cover) {
      return null;
    }

    return (
      <button
        key={collection.id}
        type="button"
        className={cn(
          "flex min-w-0 flex-col items-center gap-2 rounded-card-sm bg-surface-overlay p-3 text-center",
          "border border-border-soft transition-colors hover:border-border hover:bg-background-hover",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-focus",
        )}
        onClick={() => setSelectedAvatarCollectionId(collection.id)}
      >
        <span className="flex aspect-[4/3] w-full shrink-0 items-center justify-center overflow-hidden rounded-card-sm bg-background">
          <AvatarMedia
            media={{ src: cover.src, mediaType: cover.mediaType }}
            alt=""
            className="h-full w-full object-contain p-1"
          />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-xs text-foreground">
            {collection.label}
          </span>
          <span className="block text-[11px] text-muted-foreground">
            {t("editor.avatarCollectionCount", {
              count: collection.avatarIds.length,
            })}
          </span>
        </span>
      </button>
    );
  };

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        className={SHEET_CONTENT_CLASS}
        aria-describedby={undefined}
      >
        <form
          id="persona-form"
          onSubmit={handleSubmit}
          className="flex h-full min-h-0 flex-col"
        >
          {/* Header: title + Built-in tag at top-left. Sheet renders its own
              close X in top-right. */}
          <div className="flex items-center gap-2 px-5 pt-5 pb-3">
            <SheetTitle className="truncate text-sm font-normal text-foreground">
              {titleText}
            </SheetTitle>
            {isBuiltIn ? (
              <span className="rounded-full bg-surface-overlay px-1.5 py-0.5 text-[11px] text-foreground">
                {t("editor.builtIn")}
              </span>
            ) : null}
          </div>

          <div
            className={cn(
              "relative shrink-0 overflow-hidden bg-muted",
              HERO_HEIGHT_CLASS,
            )}
          >
            {avatarMedia ? (
              <AvatarMedia
                media={avatarMedia}
                alt={t("avatar.previewAlt")}
                className="absolute inset-0 h-full w-full object-contain p-8"
                onError={() => setAvatarPreviewFailed(true)}
              />
            ) : (
              <img
                src={fallbackAvatarSrc}
                alt=""
                aria-hidden="true"
                className="absolute inset-0 h-full w-full object-contain p-8"
              />
            )}
            {trimmedAvatarValue.length > 0 && !isReadOnly ? (
              <Button
                type="button"
                variant="destructive-flat"
                size="icon-sm"
                aria-label={t("avatar.removeAria")}
                className="absolute right-4 top-4"
                onClick={handleClearAvatar}
              >
                <Trash2 className="size-3.5" />
              </Button>
            ) : null}
          </div>

          {/* Scrollable form body. Background uses the neutral surface so the
              field pills (bg-surface-overlay) read as elevated chips. */}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-muted px-5 py-5">
            <div className={SECTION_GAP_CLASS}>
              <Label htmlFor="persona-avatar-url" className={FIELD_LABEL_CLASS}>
                {t("editor.avatarUrl")}
              </Label>
              <Input
                id="persona-avatar-url"
                type="text"
                inputMode="url"
                value={customAvatarUrlValue}
                onChange={handleAvatarUrlChange}
                readOnly={isReadOnly}
                placeholder={t("editor.avatarUrlPlaceholder")}
                aria-invalid={avatarUrlError ? true : undefined}
                aria-describedby={
                  avatarUrlError ? "persona-avatar-url-error" : undefined
                }
                className={cn(
                  PILL_INPUT_CLASS,
                  isReadOnly && "cursor-not-allowed opacity-70",
                )}
              />
              {avatarUrlError ? (
                <p
                  id="persona-avatar-url-error"
                  className="text-[11px] text-destructive"
                >
                  {avatarUrlError}
                </p>
              ) : null}
            </div>

            {!isReadOnly ? (
              <div
                className={cn(
                  "space-y-2",
                  selectedAvatarCollection &&
                    "flex min-h-[18rem] flex-col gap-2 space-y-0",
                )}
              >
                <Label className={FIELD_LABEL_CLASS}>
                  {t("editor.avatarBundled")}
                </Label>
                {selectedAvatarCollection ? (
                  <div className="flex min-h-0 flex-1 flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t("editor.avatarBackToCollections")}
                        onClick={() => setSelectedAvatarCollectionId(null)}
                      >
                        <ArrowLeft className="size-3.5" />
                      </Button>
                      <p className="text-xs text-foreground">
                        {selectedAvatarCollection.label}
                      </p>
                    </div>
                    <div className="grid min-h-0 flex-1 grid-cols-3 gap-2 overflow-y-auto pr-1">
                      {selectedAvatarCollection.avatarIds.map((avatarId) => {
                        const entry = getAvatarCatalogEntry(avatarId);
                        return entry ? renderAvatarTile(entry) : null;
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-2">
                    {avatarCollections.map(renderCollectionButton)}
                  </div>
                )}
                {avatarPreviewFailed ? (
                  <p className="text-[11px] text-muted-foreground">
                    {t("avatar.loadFailed")}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className={SECTION_GAP_CLASS}>
              <Label
                htmlFor="persona-display-name"
                className={FIELD_LABEL_CLASS}
              >
                {t("editor.displayName")}{" "}
                <span className="text-destructive">*</span>
              </Label>
              <Input
                id="persona-display-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                readOnly={isReadOnly}
                required
                placeholder={t("editor.displayNamePlaceholder")}
                className={cn(
                  PILL_INPUT_CLASS,
                  isReadOnly && "cursor-not-allowed opacity-70",
                )}
              />
            </div>

            <div className={SECTION_GAP_CLASS}>
              <Label
                htmlFor="persona-system-prompt"
                className={FIELD_LABEL_CLASS}
              >
                {t("editor.systemPrompt")}{" "}
                <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="persona-system-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                readOnly={isReadOnly}
                required
                rows={5}
                placeholder={t("editor.systemPromptPlaceholder")}
                className={cn(
                  TEXTAREA_FIELD_CLASS,
                  isReadOnly && "cursor-not-allowed opacity-70",
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className={SECTION_GAP_CLASS}>
                <Label className={FIELD_LABEL_CLASS}>
                  {t("editor.provider")}
                </Label>
                <Select
                  value={provider || "__none__"}
                  onValueChange={(v: string) => {
                    const nextProvider =
                      v === "__none__"
                        ? ("" as ProviderType | "")
                        : (v as ProviderType);
                    setProvider(nextProvider);
                    if (nextProvider !== provider) {
                      setModel("");
                    }
                  }}
                  disabled={isReadOnly}
                >
                  <SelectTrigger
                    className={cn(
                      FIELD_INPUT_CLASS,
                      "w-full",
                      isReadOnly && "cursor-not-allowed opacity-70",
                    )}
                  >
                    <SelectValue placeholder={t("common:labels.none")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">
                      {t("common:labels.none")}
                    </SelectItem>
                    {acpProviders.map((providerOption) => (
                      <SelectItem
                        key={providerOption.id}
                        value={providerOption.id}
                      >
                        {providerOption.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className={SECTION_GAP_CLASS}>
                <Label className={FIELD_LABEL_CLASS}>{t("editor.model")}</Label>
                <Select
                  value={modelSelectValue}
                  onValueChange={(value: string) => {
                    if (value === "__none__") {
                      setModel("");
                      return;
                    }
                    if (value.startsWith("__saved__:")) {
                      setModel(value.slice("__saved__:".length));
                      return;
                    }
                    setModel(value);
                  }}
                  disabled={isReadOnly || !provider}
                >
                  <SelectTrigger
                    className={cn(
                      FIELD_INPUT_CLASS,
                      "w-full",
                      (isReadOnly || !provider) &&
                        "cursor-not-allowed opacity-70",
                    )}
                  >
                    <SelectValue
                      placeholder={
                        provider
                          ? t("editor.modelPlaceholder")
                          : t("editor.chooseProviderFirst")
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">
                      {t("common:labels.none")}
                    </SelectItem>
                    {hasSavedModelOutsideInventory && (
                      <SelectItem value={`__saved__:${model}`}>
                        {t("editor.savedModelUnavailable", { model })}
                      </SelectItem>
                    )}
                    {availableModels.map((modelOption) => (
                      <SelectItem key={modelOption.id} value={modelOption.id}>
                        {modelOption.displayName ?? modelOption.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {hasSavedModelOutsideInventory ? (
                  <p className="text-[11px] text-muted-foreground">
                    {t("editor.savedModelUnavailableHelp")}
                  </p>
                ) : !provider ? null : availableModels.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">
                    {modelStatusMessage ?? t("editor.noModelsAvailable")}
                  </p>
                ) : null}
              </div>
            </div>

            {readOnlyDescription ? (
              <p className="text-xs text-muted-foreground">
                {readOnlyDescription}
              </p>
            ) : null}
          </div>

          {/* Footer: Delete + Duplicate on the left (destructive sits leftmost,
              so the destructive control is visually separated from Save), Save
              on the right. */}
          <div className="flex shrink-0 items-center justify-between gap-2 bg-muted px-5 pb-5">
            <div className="flex items-center gap-2">
              {persona && onDelete && !isReadOnly ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onDelete(persona)}
                  aria-label={t("common:actions.delete")}
                  className="h-8 rounded-full px-3 text-destructive hover:bg-surface-overlay hover:text-destructive"
                >
                  <Trash2 className="h-3 w-3" />
                  {t("common:actions.delete")}
                </Button>
              ) : null}
              {persona && onDuplicate ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onDuplicate(persona)}
                  className="h-8 rounded-full bg-surface-overlay px-3 text-foreground hover:bg-surface-overlay/90"
                >
                  <Copy className="h-3 w-3" />
                  {t("editor.duplicate")}
                </Button>
              ) : null}
            </div>
            {detailsMode ? (
              <Button
                type="button"
                size="sm"
                onClick={onClose}
                className="h-8 rounded-full px-4"
              >
                {t("common:actions.close")}
              </Button>
            ) : (
              <Button
                type="submit"
                form="persona-form"
                size="sm"
                disabled={!isValid || isPending || isReadOnly}
                className="h-8 rounded-full px-4"
              >
                {isPending
                  ? t("editor.saving")
                  : isEditing
                    ? t("common:actions.saveChanges")
                    : t("editor.create")}
              </Button>
            )}
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
