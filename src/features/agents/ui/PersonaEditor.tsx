import { useState, useEffect, useCallback, useId } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Check, Copy, Pencil, Trash2 } from "lucide-react";
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
import {
  Avatar as AvatarRoot,
  AvatarImage,
  AvatarFallback,
} from "@/shared/ui/avatar";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Textarea } from "@/shared/ui/textarea";
import { useAvatarMedia } from "@/shared/hooks/useAvatarSrc";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
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
import { normalizeAvatarUrl } from "@/shared/lib/avatarUrl";
import { useProviderInventoryStore } from "@/features/providers/stores/providerInventoryStore";
import {
  canDeletePersona,
  canEditPersona,
  getPersonaProviderLabel,
  getPersonaSource,
} from "@/features/agents/lib/personaPresentation";
import { PersonaDetails } from "./PersonaDetails";

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

export function PersonaEditor({
  persona,
  isOpen,
  mode = "create",
  onClose,
  onSave,
  onDuplicate,
  onEdit,
  onDelete,
  isPending = false,
}: PersonaEditorProps) {
  const { t } = useTranslation(["agents", "common"]);
  const isEditing = mode === "edit";
  const detailsMode = mode === "details";
  const readOnlyBySource = persona ? !canEditPersona(persona) : false;
  const isReadOnly = detailsMode || readOnlyBySource;
  const personaSource = persona ? getPersonaSource(persona) : null;
  const canEditCurrentPersona = persona ? canEditPersona(persona) : false;
  const canDeleteCurrentPersona = persona ? canDeletePersona(persona) : false;
  const acpProviders = useAgentStore((s) => s.providers);
  const setProviders = useAgentStore((s) => s.setProviders);
  const mergeInventoryEntries = useProviderInventoryStore(
    (s) => s.mergeEntries,
  );
  const { getEntry, getModelsForAgent } = useProviderInventory();
  const displayNameId = useId();
  const avatarUrlId = useId();
  const avatarUrlErrorId = useId();
  const systemPromptId = useId();

  const [displayName, setDisplayName] = useState("");
  const [avatarValue, setAvatarValue] = useState("");
  const [avatarChanged, setAvatarChanged] = useState(false);
  const [selectedAvatarCollectionId, setSelectedAvatarCollectionId] = useState<
    string | null
  >(null);
  const [avatarPreviewFailed, setAvatarPreviewFailed] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [provider, setProvider] = useState<ProviderType | "">("");
  const [model, setModel] = useState("");

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
      setAvatarValue(normalizeAvatarUrl(persona.avatar) ?? "");
      setSystemPrompt(persona.systemPrompt);
      setProvider(persona.provider ?? "");
      setModel(persona.model ?? "");
    } else if (isOpen) {
      setDisplayName("");
      setAvatarValue("");
      setSystemPrompt("");
      setProvider("");
      setModel("");
    }
    setAvatarChanged(false);
    setSelectedAvatarCollectionId(null);
    setAvatarPreviewFailed(false);
  }, [isOpen, persona]);

  const trimmedAvatarValue = avatarValue.trim();
  const normalizedAvatarValue = normalizeAvatarUrl(trimmedAvatarValue);
  const avatarUrlError =
    trimmedAvatarValue.length > 0 && !normalizedAvatarValue
      ? t("editor.avatarUrlInvalid")
      : null;
  const customAvatarUrlValue = isBundledAvatarRef(trimmedAvatarValue)
    ? ""
    : avatarValue;
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
    ? personaSource === "builtin"
      ? t("editor.readOnlyBuiltIn")
      : t("editor.readOnlyFile")
    : null;
  const providerLabel = getPersonaProviderLabel(
    provider || undefined,
    acpProviders,
    t("common:labels.none"),
  );
  const modelLabel = model || t("common:labels.none");
  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!isValid || isReadOnly) return;

      // Update requests use null to clear source properties; undefined leaves them unchanged.
      const data: CreatePersonaRequest | UpdatePersonaRequest = {
        displayName: displayName.trim(),
        avatar: isEditing
          ? avatarChanged
            ? (normalizedAvatarValue ?? null)
            : undefined
          : (normalizedAvatarValue ?? undefined),
        systemPrompt: systemPrompt.trim(),
        provider: provider || (isEditing ? null : undefined),
        model: model.trim() || (isEditing ? null : undefined),
      };
      onSave(data);
    },
    [
      isValid,
      isReadOnly,
      isEditing,
      displayName,
      normalizedAvatarValue,
      avatarChanged,
      systemPrompt,
      provider,
      model,
      onSave,
    ],
  );

  const initials = displayName.charAt(0).toUpperCase() || "?";

  const handleClearAvatar = useCallback(() => {
    setAvatarValue("");
    setAvatarChanged(true);
    setAvatarPreviewFailed(false);
  }, []);

  const handleAvatarUrlChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setAvatarValue(e.target.value);
      setAvatarChanged(true);
      setAvatarPreviewFailed(false);
    },
    [],
  );

  const selectAvatar = (avatarId: string) => {
    setAvatarValue(avatarRef(avatarId));
    setAvatarChanged(true);
    setAvatarPreviewFailed(false);
  };

  const renderAvatarTile = (entry: AvatarCatalogEntry) => {
    const ref = avatarRef(entry.id);
    const selected = normalizedAvatarValue === ref;

    return (
      <button
        key={entry.id}
        type="button"
        className={cn(
          "relative flex h-40 items-center justify-center overflow-hidden rounded-md border border-border-soft bg-muted/30 p-2 transition-colors hover:border-border",
          selected &&
            "border-background-primary ring-2 ring-background-primary/25",
        )}
        aria-label={entry.label}
        aria-pressed={selected}
        onClick={() => selectAvatar(entry.id)}
      >
        <AvatarMedia
          media={{ src: entry.src, mediaType: entry.mediaType }}
          alt=""
          lazy
          className="max-h-full max-w-full object-contain"
        />
        {selected ? (
          <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-background-primary text-text-on-primary">
            <Check className="h-3 w-3" />
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
        className="group flex min-w-0 flex-col items-center gap-2 rounded-md border border-border-soft bg-muted/20 p-3 text-center transition-colors hover:border-border hover:bg-background-hover"
        onClick={() => setSelectedAvatarCollectionId(collection.id)}
      >
        <span className="flex h-32 w-full shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/30">
          <AvatarMedia
            media={{ src: cover.src, mediaType: cover.mediaType }}
            alt=""
            className="h-full w-full object-contain p-1"
          />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-xs font-medium text-foreground">
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
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid max-h-[94dvh] max-w-3xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-5 py-4">
          <DialogTitle className="text-sm">
            {detailsMode
              ? persona?.displayName
              : isEditing
                ? t("editor.editTitle")
                : t("editor.newTitle")}
          </DialogTitle>
          {readOnlyDescription ? (
            <p className="text-xs text-muted-foreground">
              {readOnlyDescription}
            </p>
          ) : null}
        </DialogHeader>

        {detailsMode && personaSource ? (
          <PersonaDetails
            avatar={normalizedAvatarValue ?? null}
            displayName={displayName}
            modelLabel={modelLabel}
            personaSource={personaSource}
            providerLabel={providerLabel}
            systemPrompt={systemPrompt}
          />
        ) : (
          <form
            id="persona-form"
            onSubmit={handleSubmit}
            className="min-h-0 overflow-y-auto space-y-4 px-5 pb-5"
          >
            <div className="space-y-3">
              <div className="flex justify-center">
                <div className="relative">
                  <AvatarRoot className="h-[clamp(8rem,28vh,12rem)] w-[clamp(8rem,28vh,12rem)] overflow-visible rounded-none bg-transparent">
                    {avatarMedia?.mediaType === "video" ? (
                      <AvatarMedia
                        media={avatarMedia}
                        alt={t("avatar.previewAlt")}
                        className="object-contain"
                        onError={() => setAvatarPreviewFailed(true)}
                      />
                    ) : (
                      <>
                        <AvatarImage
                          src={avatarMedia?.src}
                          alt={t("avatar.previewAlt")}
                          className="object-contain"
                          onError={() => setAvatarPreviewFailed(true)}
                        />
                        <AvatarFallback className="rounded-full text-4xl font-semibold">
                          {initials}
                        </AvatarFallback>
                      </>
                    )}
                  </AvatarRoot>
                  {trimmedAvatarValue.length > 0 && !isReadOnly ? (
                    <Button
                      type="button"
                      variant="destructive-flat"
                      size="icon-xs"
                      aria-label={t("avatar.removeAria")}
                      className="absolute right-1 top-1"
                      onClick={handleClearAvatar}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  ) : null}
                </div>
              </div>

              {!isReadOnly ? (
                <div className="space-y-1">
                  <Label
                    htmlFor={avatarUrlId}
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {t("editor.avatarUrl")}
                  </Label>
                  <Input
                    id={avatarUrlId}
                    type="text"
                    inputMode="url"
                    value={customAvatarUrlValue}
                    onChange={handleAvatarUrlChange}
                    aria-invalid={avatarUrlError ? true : undefined}
                    aria-describedby={
                      avatarUrlError ? avatarUrlErrorId : undefined
                    }
                    placeholder={t("editor.avatarUrlPlaceholder")}
                  />
                  {avatarUrlError ? (
                    <p
                      id={avatarUrlErrorId}
                      className="text-[11px] text-text-danger"
                    >
                      {avatarUrlError}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {!isReadOnly ? (
                <div
                  className={cn(
                    "space-y-3",
                    selectedAvatarCollection &&
                      "flex h-[18.5rem] min-h-0 flex-col gap-3 space-y-0",
                  )}
                >
                  <p className="text-xs font-medium text-muted-foreground">
                    {t("editor.avatarBundled")}
                  </p>
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
                          <ArrowLeft className="h-3.5 w-3.5" />
                        </Button>
                        <p className="text-xs font-medium text-foreground">
                          {selectedAvatarCollection.label}
                        </p>
                      </div>
                      <div className="grid min-h-0 flex-1 grid-cols-3 gap-3 overflow-y-auto pr-1">
                        {selectedAvatarCollection.avatarIds.map((avatarId) => {
                          const entry = getAvatarCatalogEntry(avatarId);
                          return entry ? renderAvatarTile(entry) : null;
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-3">
                      {avatarCollections.map(renderCollectionButton)}
                    </div>
                  )}
                </div>
              ) : null}
              {avatarPreviewFailed ? (
                <p className="text-center text-[11px] text-muted-foreground">
                  {t("avatar.loadFailed")}
                </p>
              ) : null}
            </div>

            <div className="space-y-1">
              <Label
                htmlFor={displayNameId}
                className="text-xs font-medium text-muted-foreground"
              >
                {t("editor.displayName")}{" "}
                <span className="text-text-danger">*</span>
              </Label>
              <Input
                id={displayNameId}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                readOnly={isReadOnly}
                required
                placeholder={t("editor.displayNamePlaceholder")}
                className={cn(isReadOnly && "opacity-70 cursor-not-allowed")}
              />
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label
                  htmlFor={systemPromptId}
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t("editor.systemPrompt")}{" "}
                  <span className="text-text-danger">*</span>
                </Label>
                <span className="text-[10px] text-muted-foreground">
                  {t("common:labels.characterCount", {
                    count: systemPrompt.length,
                  })}
                </span>
              </div>
              <Textarea
                id={systemPromptId}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                readOnly={isReadOnly}
                required
                rows={6}
                placeholder={t("editor.systemPromptPlaceholder")}
                className={cn(
                  "leading-relaxed",
                  isReadOnly && "opacity-70 cursor-not-allowed",
                )}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs font-medium text-muted-foreground">
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
                      "w-full",
                      isReadOnly && "opacity-70 cursor-not-allowed",
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

              <div className="space-y-1">
                <Label className="text-xs font-medium text-muted-foreground">
                  {t("editor.model")}
                </Label>
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
                      "w-full",
                      isReadOnly && "opacity-70 cursor-not-allowed",
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
              </div>
            </div>
            {hasSavedModelOutsideInventory ? (
              <p className="text-[11px] text-muted-foreground">
                {t("editor.savedModelUnavailableHelp")}
              </p>
            ) : availableModels.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                {modelStatusMessage ?? t("editor.noModelsAvailable")}
              </p>
            ) : null}
          </form>
        )}

        <DialogFooter className="shrink-0 border-t px-5 py-4">
          {detailsMode && persona ? (
            <>
              {onEdit && canEditCurrentPersona ? (
                <Button
                  type="button"
                  variant="outline-flat"
                  size="sm"
                  onClick={() => onEdit(persona)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  {t("common:actions.edit")}
                </Button>
              ) : null}
              {onDuplicate ? (
                <Button
                  type="button"
                  variant="outline-flat"
                  size="sm"
                  onClick={() => onDuplicate(persona)}
                >
                  <Copy className="h-3.5 w-3.5" />
                  {t("editor.duplicate")}
                </Button>
              ) : null}
              {onDelete && canDeleteCurrentPersona ? (
                <Button
                  type="button"
                  variant="destructive-flat"
                  size="sm"
                  onClick={() => onDelete(persona)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("common:actions.delete")}
                </Button>
              ) : null}
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                {t("common:actions.close")}
              </Button>
            </>
          ) : isReadOnly && onDuplicate && persona ? (
            <>
              <Button
                type="button"
                variant="outline-flat"
                size="sm"
                onClick={() => onDuplicate(persona)}
              >
                <Copy className="h-3.5 w-3.5" />
                {t("editor.duplicate")}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                {t("common:actions.close")}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                {t("common:actions.cancel")}
              </Button>
              <Button
                type="submit"
                form="persona-form"
                size="sm"
                disabled={!isValid || isPending}
              >
                {isPending
                  ? t("editor.saving")
                  : isEditing
                    ? t("common:actions.saveChanges")
                    : t("editor.create")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
