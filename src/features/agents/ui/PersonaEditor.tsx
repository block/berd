import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Copy, RefreshCw, Trash2 } from "lucide-react";
import {
  avatarRef,
  getAvatarCatalogEntry,
  isBundledAvatarRef,
  parseAvatarRef,
} from "@/shared/avatars/catalog";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Textarea } from "@/shared/ui/textarea";
import { Sheet, SheetContent, SheetTitle } from "@/shared/ui/sheet";
import { normalizeAvatarUrl } from "@/shared/lib/avatarUrl";
import { useAvatarMediaState } from "@/shared/hooks/useAvatarSrc";
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
import { useAvatarLibrary } from "@/features/agents/hooks/useAvatarLibrary";
import { AvatarLibraryPicker } from "@/features/agents/ui/AvatarLibraryPicker";

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

const AGENT_PANEL_COLOR = "#d9d9d9";
const SHEET_CONTENT_CLASS =
  "top-3 right-3 bottom-3 h-auto w-[calc(100vw-1.5rem)] gap-0 overflow-hidden rounded-[24px] bg-[rgba(217,217,217,0.42)] p-0 shadow-[0_22px_72px_rgba(15,23,42,0.18)] backdrop-blur-2xl sm:top-5 sm:right-5 sm:bottom-5 sm:w-[560px] sm:max-w-none";
const CLOSE_BUTTON_CLASS =
  "top-5 right-5 rounded-full bg-transparent opacity-80 hover:bg-white/50";
const HERO_HEIGHT_CLASS = "h-[400px]";
const FIELD_INPUT_CLASS =
  "h-[42px] !rounded-[10px] border-0 bg-white px-3.5 py-0 text-[14px] leading-[15px] text-[#242424] shadow-none outline-none transition-[border-radius,box-shadow,background-color] duration-200 placeholder:text-[#242424]/30 hover:!rounded-[20px] hover:shadow-[0_1px_1px_rgba(0,0,0,0.24)] focus:!rounded-[20px] focus:shadow-[0_1px_1px_rgba(0,0,0,0.24)] focus-visible:!rounded-[20px] focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:shadow-[0_1px_1px_rgba(0,0,0,0.24)]";
const SELECT_TRIGGER_CLASS =
  "!h-[42px] min-h-[42px] !rounded-[10px] border-0 bg-white px-3.5 py-0 text-[14px] leading-[15px] text-[#242424] shadow-none outline-none transition-[border-radius,box-shadow,background-color] duration-200 data-[placeholder]:text-[#242424]/30 data-[size=default]:!h-[42px] hover:!rounded-[20px] hover:shadow-[0_1px_1px_rgba(0,0,0,0.24)] focus:!rounded-[20px] focus:shadow-[0_1px_1px_rgba(0,0,0,0.24)] focus-visible:!rounded-[20px] focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:shadow-[0_1px_1px_rgba(0,0,0,0.24)] data-[state=open]:!rounded-[20px] data-[state=open]:shadow-[0_1px_1px_rgba(0,0,0,0.24)]";
const TEXTAREA_FIELD_CLASS =
  "h-[215px] min-h-[215px] w-full resize-none rounded-[10px] border-0 bg-white px-3.5 py-[13px] text-[14px] leading-[15px] text-[#242424] shadow-none outline-none transition-[border-radius,box-shadow,background-color] duration-200 placeholder:text-[#242424]/30 hover:rounded-[28px] hover:shadow-[0_1px_1px_rgba(0,0,0,0.18)] focus:rounded-[28px] focus:shadow-[0_1px_1px_rgba(0,0,0,0.18)] focus:outline-none";
const FIELD_LABEL_CLASS =
  "text-[10px] leading-3 font-normal text-[#242424] opacity-40 group-hover/field:opacity-100 group-focus-within/field:opacity-100";
const SECTION_GAP_CLASS = "group/field space-y-2";

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
  const [avatarPreviewFailed, setAvatarPreviewFailed] = useState(false);
  const [formHasScrollBelow, setFormHasScrollBelow] = useState(false);
  const formBodyRef = useRef<HTMLDivElement>(null);
  const avatarLibrary = useAvatarLibrary(isOpen && !isReadOnly);

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
  const selectedAvatarId = normalizedAvatarValue
    ? parseAvatarRef(normalizedAvatarValue)
    : undefined;
  const selectedCachedAvatarMedia = selectedAvatarId
    ? avatarLibrary.cachedAvatarMediaById[selectedAvatarId]
    : undefined;
  const selectedCatalogMedia =
    selectedCachedAvatarMedia &&
    selectedCachedAvatarMedia.catalogVersion ===
      avatarLibrary.catalog?.catalogVersion
      ? selectedCachedAvatarMedia.media
      : undefined;
  const avatarMediaState = useAvatarMediaState(
    selectedCatalogMedia || selectedAvatarId
      ? null
      : (normalizedAvatarValue ?? null),
  );
  const avatarMedia = selectedCatalogMedia ?? avatarMediaState.media;
  const selectedCatalogEntry =
    selectedAvatarId && avatarLibrary.catalog
      ? getAvatarCatalogEntry(avatarLibrary.catalog, selectedAvatarId)
      : undefined;
  const appAvatarValidationPending =
    Boolean(selectedAvatarId) && !avatarLibrary.catalog;
  const unknownAppAvatarSelected =
    Boolean(selectedAvatarId) &&
    Boolean(avatarLibrary.catalog) &&
    !selectedCatalogEntry;
  const changedAppAvatarUnavailable =
    Boolean(selectedAvatarId) &&
    avatarChanged &&
    Boolean(selectedCatalogEntry) &&
    !selectedCatalogMedia;
  const avatarValidationError = unknownAppAvatarSelected
    ? t("avatar.loadFailed")
    : changedAppAvatarUnavailable
      ? t("avatar.loadFailed")
      : avatarUrlError;

  const isValid =
    displayName.trim().length > 0 &&
    systemPrompt.trim().length > 0 &&
    !appAvatarValidationPending &&
    !avatarValidationError;

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

  const updateFooterDivider = useCallback(() => {
    const formBody = formBodyRef.current;
    if (!formBody) {
      setFormHasScrollBelow(false);
      return;
    }

    setFormHasScrollBelow(
      formBody.scrollHeight - formBody.scrollTop - formBody.clientHeight > 1,
    );
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setFormHasScrollBelow(false);
      return;
    }

    const frameId = window.requestAnimationFrame(updateFooterDivider);
    window.addEventListener("resize", updateFooterDivider);
    const formBody = formBodyRef.current;
    let mutationObserver: MutationObserver | null = null;
    if (formBody) {
      mutationObserver = new MutationObserver(updateFooterDivider);
      mutationObserver.observe(formBody, { childList: true, subtree: true });
    }

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", updateFooterDivider);
      mutationObserver?.disconnect();
    };
  }, [isOpen, updateFooterDivider]);

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

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        className={SHEET_CONTENT_CLASS}
        closeButtonClassName={CLOSE_BUTTON_CLASS}
        overlayClassName="bg-transparent"
        style={{
          backgroundColor: `color-mix(in oklab, ${AGENT_PANEL_COLOR} 40%, transparent)`,
        }}
        aria-describedby={undefined}
      >
        <form
          id="persona-form"
          onSubmit={handleSubmit}
          className="flex h-full min-h-0 flex-col"
        >
          {/* Header: title + Built-in tag at top-left. Sheet renders its own
              close X in top-right. */}
          <div className="flex items-center gap-2 px-8 pt-5 pb-2">
            <SheetTitle className="truncate text-sm font-normal text-foreground">
              {titleText}
            </SheetTitle>
            {isBuiltIn ? (
              <span className="rounded-full bg-white/70 px-1.5 py-0.5 text-[11px] text-[#242424]">
                {t("editor.builtIn")}
              </span>
            ) : null}
          </div>

          {/* Hero stays transparent so the glass panel matches project create. */}
          <div
            className={cn(
              "relative shrink-0 overflow-hidden",
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
            {avatarMediaState.loading ? (
              <div className="absolute inset-x-0 bottom-4 text-center text-[11px] text-muted-foreground">
                {t("editor.avatarDownloading")}
              </div>
            ) : null}
            {avatarMediaState.unavailable ? (
              <div className="absolute inset-x-0 bottom-4 flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
                <span>{t("avatar.loadFailed")}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={avatarMediaState.retry}
                >
                  <RefreshCw className="size-3" />
                  {t("editor.avatarRetry")}
                </Button>
              </div>
            ) : null}
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

          <div
            ref={formBodyRef}
            onScroll={updateFooterDivider}
            className="min-h-0 flex-1 space-y-5 overflow-y-auto bg-transparent px-6 py-5 sm:px-8"
          >
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
                aria-invalid={avatarValidationError ? true : undefined}
                aria-describedby={
                  avatarValidationError ? "persona-avatar-url-error" : undefined
                }
                className={cn(
                  FIELD_INPUT_CLASS,
                  isReadOnly && "cursor-not-allowed opacity-70",
                )}
              />
              {avatarValidationError ? (
                <p
                  id="persona-avatar-url-error"
                  className="text-[11px] text-destructive"
                >
                  {avatarValidationError}
                </p>
              ) : null}
            </div>

            {!isReadOnly ? (
              <div className="space-y-2">
                <Label className={FIELD_LABEL_CLASS}>
                  {t("editor.avatarLibrary")}
                </Label>
                <AvatarLibraryPicker
                  library={avatarLibrary}
                  selectedAvatarRef={normalizedAvatarValue ?? null}
                  onSelectAvatar={handleSelectAvatar}
                  onPreviewError={() => setAvatarPreviewFailed(true)}
                />
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
                  FIELD_INPUT_CLASS,
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

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                      SELECT_TRIGGER_CLASS,
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
                      SELECT_TRIGGER_CLASS,
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

          <div
            className={cn(
              "flex shrink-0 flex-wrap items-center justify-between gap-3 border-t bg-transparent px-6 pt-4 pb-7 transition-[border-color,box-shadow] duration-200 sm:px-8",
              formHasScrollBelow
                ? "border-[#242424]/10 shadow-[0_-12px_24px_rgba(36,36,36,0.06)]"
                : "border-transparent shadow-none",
            )}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {persona && onDelete && !isReadOnly ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onDelete(persona)}
                  aria-label={t("common:actions.delete")}
                  className="h-10 rounded-full px-4 text-sm text-destructive hover:bg-white/50 hover:text-destructive"
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
                  className="h-10 rounded-full bg-white px-4 text-sm text-[#242424] hover:bg-white/90"
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
                className="h-10 rounded-full !bg-[#242424] px-5 text-sm !text-white hover:!bg-[#242424]/90"
              >
                {t("common:actions.close")}
              </Button>
            ) : (
              <div className="ml-auto flex items-center justify-end gap-3">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onClose}
                  disabled={isPending}
                  className="h-10 rounded-full px-4 text-sm hover:bg-white/50"
                >
                  {t("common:actions.cancel")}
                </Button>
                <Button
                  type="submit"
                  form="persona-form"
                  size="sm"
                  disabled={!isValid || isPending || isReadOnly}
                  className="h-10 rounded-full !bg-[#242424] px-5 text-sm !text-white hover:!bg-[#242424]/90 disabled:!bg-[#242424] disabled:!text-white"
                >
                  {isPending
                    ? t("editor.saving")
                    : isEditing
                      ? t("common:actions.saveChanges")
                      : t("editor.create")}
                </Button>
              </div>
            )}
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
