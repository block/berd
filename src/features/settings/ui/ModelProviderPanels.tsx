import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Spinner } from "@/shared/ui/spinner";
import type {
  ProviderField,
  ProviderFieldValue,
  ProviderSetupMethod,
} from "@/shared/types/providers";
import {
  resolveFieldValue,
  getDisplayValue,
  renderSetupMessage,
  renderInlineCodeMessage,
} from "./modelProviderHelpers";

interface ModelRefreshMessageProps {
  syncing: boolean;
  warning?: string | null;
}

export function ModelRefreshMessage({
  syncing,
  warning,
}: ModelRefreshMessageProps) {
  const { t } = useTranslation("settings");

  if (syncing) {
    return (
      <p
        role="status"
        className="flex items-center gap-2 text-xs text-muted-foreground"
      >
        <Spinner className="size-3 text-primary" />
        <span>{t("providers.loadingModels")}</span>
      </p>
    );
  }

  if (warning) {
    return (
      <p
        role="status"
        className="rounded-md border border-warning bg-warning/20 px-2.5 py-2 text-xs text-warning"
      >
        {t("providers.modelRefreshWarning", { message: warning })}
      </p>
    );
  }

  return null;
}

interface ConnectedFieldsPanelProps {
  panelRef: RefObject<HTMLDivElement | null>;
  fields: ProviderField[];
  fieldValueMap: Map<string, ProviderFieldValue>;
  editingKey: string | null;
  draftValues: Record<string, string>;
  saving: boolean;
  modelSyncing: boolean;
  modelWarning?: string | null;
  showSavedState: boolean;
  error: string;
  setupMessage: string | null;
  onStartEdit: (key: string) => void;
  onCancelEdit: (field: ProviderField) => void;
  onDraftChange: (key: string, value: string) => void;
  onSaveField: (field: ProviderField) => void;
  onRemove: () => void;
}

export function ConnectedFieldsPanel({
  panelRef,
  fields,
  fieldValueMap,
  editingKey,
  draftValues,
  saving,
  modelSyncing,
  modelWarning,
  showSavedState,
  error,
  setupMessage,
  onStartEdit,
  onCancelEdit,
  onDraftChange,
  onSaveField,
  onRemove,
}: ConnectedFieldsPanelProps) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className="focus-override mx-3 space-y-3 rounded-b-lg border-x border-b px-3 py-3 outline-none"
    >
      {fields.map((field) => {
        const isEditing = editingKey === field.key;
        return (
          <div
            key={field.key}
            className="space-y-2 rounded-md border border-border px-3 py-2.5"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm">{field.label}</p>
                {!isEditing && (
                  <p className="truncate text-xs text-muted-foreground">
                    {getDisplayValue(field, fieldValueMap, t)}
                  </p>
                )}
              </div>

              {!isEditing && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => onStartEdit(field.key)}
                  disabled={saving}
                  className="text-muted-foreground"
                >
                  {resolveFieldValue(field, fieldValueMap).isSet
                    ? "Edit"
                    : "Add"}
                </Button>
              )}
            </div>

            {isEditing && (
              <div className="flex items-center gap-2">
                <Input
                  type={field.secret ? "password" : "text"}
                  value={draftValues[field.key] ?? ""}
                  placeholder={
                    field.secret &&
                    resolveFieldValue(field, fieldValueMap).isSet
                      ? getDisplayValue(field, fieldValueMap, t)
                      : (field.placeholder ?? undefined)
                  }
                  onChange={(event) =>
                    onDraftChange(field.key, event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      onSaveField(field);
                    }
                  }}
                  disabled={saving}
                  className="h-8 flex-1 text-xs"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onSaveField(field)}
                  disabled={saving || !(draftValues[field.key]?.trim() ?? "")}
                  className="h-8"
                >
                  {saving ? <Spinner className="size-3" /> : null}
                  {t("common:actions.save")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onCancelEdit(field)}
                  disabled={saving}
                  className="h-8"
                >
                  {t("common:actions.cancel")}
                </Button>
              </div>
            )}
          </div>
        );
      })}

      <div className="flex justify-end gap-2">
        {showSavedState ? (
          <Button type="button" variant="secondary" size="sm" disabled>
            {t("providers.saved")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onRemove()}
          disabled={saving}
          className="text-destructive hover:text-destructive"
        >
          {saving ? <Spinner className="size-3" /> : null}
          {t("providers.disconnect")}
        </Button>
      </div>
      {renderSetupMessage(setupMessage)}
      <ModelRefreshMessage syncing={modelSyncing} warning={modelWarning} />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

interface SetupFieldsPanelProps {
  panelRef: RefObject<HTMLDivElement | null>;
  fields: ProviderField[];
  fieldValueMap: Map<string, ProviderFieldValue>;
  draftValues: Record<string, string>;
  saving: boolean;
  modelSyncing: boolean;
  modelWarning?: string | null;
  showSavedState: boolean;
  error: string;
  setupMethod: ProviderSetupMethod;
  setupMessage: string | null;
  fieldSetupDescription: string | null;
  isConnected: boolean;
  onDraftChange: (key: string, value: string) => void;
  onSaveSetup: () => void;
}

export function SetupFieldsPanel({
  panelRef,
  fields,
  fieldValueMap,
  draftValues,
  saving,
  modelSyncing,
  modelWarning,
  showSavedState,
  error,
  setupMethod,
  setupMessage,
  fieldSetupDescription,
  isConnected,
  onDraftChange,
  onSaveSetup,
}: SetupFieldsPanelProps) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className="focus-override mx-3 space-y-3 rounded-b-lg border-x border-b px-3 py-3 outline-none"
    >
      {!isConnected && fieldSetupDescription ? (
        <p className="text-xs text-muted-foreground">{fieldSetupDescription}</p>
      ) : null}
      {fields.map((field) => {
        const fieldValue = resolveFieldValue(field, fieldValueMap);
        return (
          <div key={field.key} className="space-y-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-foreground">
                {field.label}
              </span>
              {field.required && (
                <span className="text-xxs text-muted-foreground">
                  {t("common:labels.required")}
                </span>
              )}
            </div>
            <Input
              type={field.secret ? "password" : "text"}
              value={draftValues[field.key] ?? ""}
              placeholder={
                field.secret && fieldValue.isSet
                  ? getDisplayValue(field, fieldValueMap, t)
                  : (field.placeholder ?? undefined)
              }
              onChange={(event) => onDraftChange(field.key, event.target.value)}
              disabled={saving}
              className="h-8 text-xs"
            />
          </div>
        );
      })}

      <div className="flex justify-end">
        <Button
          type="button"
          feedbackState={
            saving ? "loading" : showSavedState ? "success" : "idle"
          }
          loadingLabel={t("providers.saving")}
          successLabel={t("providers.saved")}
          loadingVisual="text"
          loadingDelayMs={250}
          preserveWidth
          size="sm"
          onClick={() => onSaveSetup()}
          disabled={saving || showSavedState}
          className="h-8"
        >
          {t("common:actions.save")}
        </Button>
      </div>
      {setupMethod === "host_with_oauth_fallback"
        ? renderInlineCodeMessage(
            t("providers.models.setup.hostWithOauthFallbackTerminal"),
          )
        : null}
      {setupMethod === "cloud_credentials" && setupMessage
        ? renderSetupMessage(setupMessage)
        : null}
      <ModelRefreshMessage syncing={modelSyncing} warning={modelWarning} />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
