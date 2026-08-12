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
import { connectionHintKeyForError } from "@/features/providers/lib/connectionErrorHints";

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
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Spinner className="size-3 text-primary" />
        <span>{t("providers.loadingModels")}</span>
      </p>
    );
  }

  if (warning) {
    const hintKey = connectionHintKeyForError(warning);
    return (
      <p
        role="status"
        className="rounded-sm border border-warning bg-warning/20 px-2.5 py-2 text-sm text-warning"
      >
        {hintKey
          ? t(hintKey, { message: warning })
          : t("providers.modelRefreshWarning", { message: warning })}
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
  const saveLabel = t("common:actions.save");
  const cancelLabel = t("common:actions.cancel");

  function renderEqualWidthEditActionLabel(label: string) {
    return (
      <span className="grid">
        <span
          aria-hidden="true"
          className="invisible col-start-1 row-start-1 whitespace-nowrap"
        >
          {saveLabel}
        </span>
        <span
          aria-hidden="true"
          className="invisible col-start-1 row-start-1 whitespace-nowrap"
        >
          {cancelLabel}
        </span>
        <span className="col-start-1 row-start-1 justify-self-center whitespace-nowrap">
          {label}
        </span>
      </span>
    );
  }

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className="focus-override space-y-3 pt-0 pb-3 outline-none"
    >
      {fields.map((field) => {
        const isEditing = editingKey === field.key;
        return (
          <div key={field.key} className="space-y-2 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm">{field.label}</p>
                {!isEditing && (
                  <p className="truncate text-sm text-muted-foreground">
                    {getDisplayValue(field, fieldValueMap, t)}
                  </p>
                )}
              </div>

              {!isEditing && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => onStartEdit(field.key)}
                  disabled={saving}
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
                  className="h-8 flex-1 text-sm"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onSaveField(field)}
                  disabled={saving || !(draftValues[field.key]?.trim() ?? "")}
                  className="h-8"
                >
                  {saving ? <Spinner className="size-3" /> : null}
                  {renderEqualWidthEditActionLabel(saveLabel)}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onCancelEdit(field)}
                  disabled={saving}
                  className="h-8"
                >
                  {renderEqualWidthEditActionLabel(cancelLabel)}
                </Button>
              </div>
            )}
          </div>
        );
      })}

      <div className="flex gap-2">
        {showSavedState ? (
          <Button type="button" variant="subtle" size="sm" disabled>
            {t("providers.saved")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          destructive
          size="sm"
          onClick={() => onRemove()}
          disabled={saving}
          className="w-full"
        >
          {saving ? <Spinner className="size-3" /> : null}
          {t("providers.disconnect")}
        </Button>
      </div>
      {renderSetupMessage(setupMessage)}
      <ModelRefreshMessage syncing={modelSyncing} warning={modelWarning} />
      {error && <p className="text-sm text-destructive">{error}</p>}
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
  onDraftChange,
  onSaveSetup,
}: SetupFieldsPanelProps) {
  const { t } = useTranslation(["settings", "common"]);
  const showInlineSave = fields.length === 1;
  const saveButton = (
    <Button
      type="button"
      feedbackState={saving ? "loading" : showSavedState ? "success" : "idle"}
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
  );

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className="focus-override space-y-3 pt-3 pb-3 outline-none"
    >
      {fields.map((field) => {
        const fieldValue = resolveFieldValue(field, fieldValueMap);
        return (
          <div key={field.key} className="space-y-1">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium text-foreground">
                {field.label}
              </span>
              {field.required && (
                <span className="text-sm text-muted-foreground">
                  {t("common:labels.required")}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Input
                type={field.secret ? "password" : "text"}
                value={draftValues[field.key] ?? ""}
                placeholder={
                  field.secret && fieldValue.isSet
                    ? getDisplayValue(field, fieldValueMap, t)
                    : (field.placeholder ?? undefined)
                }
                onChange={(event) =>
                  onDraftChange(field.key, event.target.value)
                }
                disabled={saving}
                className="h-8 flex-1 text-sm"
              />
              {showInlineSave ? saveButton : null}
            </div>
          </div>
        );
      })}

      {!showInlineSave ? (
        <div className="flex justify-end">{saveButton}</div>
      ) : null}
      {setupMethod === "host_with_oauth_fallback"
        ? renderInlineCodeMessage(
            t("providers.models.setup.hostWithOauthFallbackTerminal"),
          )
        : null}
      {setupMethod === "cloud_credentials" && setupMessage
        ? renderSetupMessage(setupMessage)
        : null}
      <ModelRefreshMessage syncing={modelSyncing} warning={modelWarning} />
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
