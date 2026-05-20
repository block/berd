import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Sparkles, Trash2 } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Textarea } from "@/shared/ui/textarea";
import { Sheet, SheetContent, SheetTitle } from "@/shared/ui/sheet";
import { normalizeAvatarUrl } from "@/shared/lib/avatarUrl";
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
  const [avatarUrl, setAvatarUrl] = useState("");

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
      setAvatarUrl(normalizeAvatarUrl(persona.avatar) ?? "");
    } else if (isOpen) {
      setDisplayName("");
      setSystemPrompt("");
      setProvider("");
      setModel("");
      setAvatarUrl("");
    }
  }, [isOpen, persona]);

  const trimmedAvatarUrl = avatarUrl.trim();
  const normalizedAvatarUrl = normalizeAvatarUrl(trimmedAvatarUrl);
  const savedAvatarUrl = persona ? normalizeAvatarUrl(persona.avatar) : null;
  const avatarUrlError =
    trimmedAvatarUrl.length > 0 && !normalizedAvatarUrl
      ? t("editor.avatarUrlInvalid")
      : null;

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

  // Hero rendering uses only the deterministic local goose PNG. Custom avatar
  // URLs are validated and saved below, but are not auto-loaded in the editor.
  const fallbackAvatarSrc = resolveAgentIcon(persona?.id ?? "new");

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!isValid || isReadOnly) return;

      // Update requests use null to clear source properties; undefined leaves them unchanged.
      const avatarValue = isEditing
        ? normalizedAvatarUrl
          ? normalizedAvatarUrl === savedAvatarUrl
            ? undefined
            : normalizedAvatarUrl
          : savedAvatarUrl
            ? null
            : undefined
        : (normalizedAvatarUrl ?? undefined);
      const data: CreatePersonaRequest | UpdatePersonaRequest = {
        displayName: displayName.trim(),
        systemPrompt: systemPrompt.trim(),
        provider: provider || (isEditing ? null : undefined),
        model: model.trim() || (isEditing ? null : undefined),
        avatar: avatarValue,
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
      normalizedAvatarUrl,
      savedAvatarUrl,
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

          {/* Hero: goose avatar PNG over neutral backdrop, with a floating
              Customize pill anchored bottom-right. */}
          <div
            className={cn(
              "relative shrink-0 overflow-hidden bg-muted",
              HERO_HEIGHT_CLASS,
            )}
          >
            <img
              src={fallbackAvatarSrc}
              alt=""
              className="absolute inset-0 h-full w-full object-contain"
            />
            <button
              type="button"
              disabled
              title={t("editor.customizeComingSoon")}
              className="absolute right-4 bottom-4 inline-flex h-8 items-center gap-1.5 rounded-full bg-surface-overlay px-3 text-sm text-foreground opacity-90 disabled:cursor-not-allowed"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {t("editor.customize")}
            </button>
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
                type="url"
                value={avatarUrl}
                onChange={(e) => setAvatarUrl(e.target.value)}
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
