import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Pencil, Trash2 } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import {
  Avatar as AvatarRoot,
  AvatarImage,
  AvatarFallback,
} from "@/shared/ui/avatar";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Textarea } from "@/shared/ui/textarea";
import { useAvatarSrc } from "@/shared/hooks/useAvatarSrc";
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

  const [displayName, setDisplayName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
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
      setAvatarUrl(normalizeAvatarUrl(persona.avatar) ?? "");
      setSystemPrompt(persona.systemPrompt);
      setProvider(persona.provider ?? "");
      setModel(persona.model ?? "");
    } else if (isOpen) {
      setDisplayName("");
      setAvatarUrl("");
      setSystemPrompt("");
      setProvider("");
      setModel("");
    }
    setAvatarPreviewFailed(false);
  }, [isOpen, persona]);

  const trimmedAvatarUrl = avatarUrl.trim();
  const normalizedAvatarUrl = normalizeAvatarUrl(trimmedAvatarUrl);
  const avatarUrlError =
    trimmedAvatarUrl.length > 0 && !normalizedAvatarUrl
      ? t("editor.avatarUrlInvalid")
      : null;
  const avatarSrc = useAvatarSrc(normalizedAvatarUrl ?? null);
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
        avatar: normalizedAvatarUrl ?? (isEditing ? null : undefined),
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
      normalizedAvatarUrl,
      systemPrompt,
      provider,
      model,
      onSave,
    ],
  );

  const initials = displayName.charAt(0).toUpperCase() || "?";

  const handleAvatarUrlChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setAvatarUrl(e.target.value);
      setAvatarPreviewFailed(false);
    },
    [],
  );

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col gap-0 p-0">
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
            avatar={normalizedAvatarUrl ?? null}
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
            className="min-h-0 flex-1 overflow-y-auto space-y-4 px-5 pb-5"
          >
            <div className="flex justify-center">
              <div className="relative">
                <AvatarRoot className="h-16 w-16 border border-border">
                  <AvatarImage
                    src={avatarSrc ?? undefined}
                    alt={t("avatar.previewAlt")}
                    onError={() => setAvatarPreviewFailed(true)}
                  />
                  <AvatarFallback className="text-lg font-semibold">
                    {initials}
                  </AvatarFallback>
                </AvatarRoot>
                {trimmedAvatarUrl.length > 0 && !isReadOnly ? (
                  <Button
                    type="button"
                    variant="destructive-flat"
                    size="icon-xs"
                    aria-label={t("avatar.removeAria")}
                    className="absolute -right-2 -top-2"
                    onClick={() => {
                      setAvatarUrl("");
                      setAvatarPreviewFailed(false);
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("editor.avatarUrl")}
              </Label>
              <Input
                type="text"
                inputMode="url"
                value={avatarUrl}
                onChange={handleAvatarUrlChange}
                readOnly={isReadOnly}
                aria-invalid={avatarUrlError ? true : undefined}
                aria-describedby={
                  avatarUrlError ? "avatar-url-error" : undefined
                }
                placeholder={t("editor.avatarUrlPlaceholder")}
                className={cn(isReadOnly && "opacity-70 cursor-not-allowed")}
              />
              {avatarUrlError ? (
                <p
                  id="avatar-url-error"
                  className="text-[11px] text-destructive"
                >
                  {avatarUrlError}
                </p>
              ) : avatarPreviewFailed ? (
                <p className="text-[11px] text-muted-foreground">
                  {t("avatar.loadFailed")}
                </p>
              ) : null}
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("editor.displayName")}{" "}
                <span className="text-destructive">*</span>
              </Label>
              <Input
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
                <Label className="text-xs font-medium text-muted-foreground">
                  {t("editor.systemPrompt")}{" "}
                  <span className="text-destructive">*</span>
                </Label>
                <span className="text-[10px] text-muted-foreground">
                  {t("common:labels.characterCount", {
                    count: systemPrompt.length,
                  })}
                </span>
              </div>
              <Textarea
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
              {hasSavedModelOutsideInventory ? (
                <p className="text-[11px] text-muted-foreground">
                  {t("editor.savedModelUnavailableHelp")}
                </p>
              ) : !provider ? (
                <p className="text-[11px] text-muted-foreground">
                  {t("editor.chooseProviderFirst")}
                </p>
              ) : availableModels.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  {modelStatusMessage ?? t("editor.noModelsAvailable")}
                </p>
              ) : null}
            </div>
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
