import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { Button } from "@/shared/ui/button";
import { Skeleton } from "@/shared/ui/skeleton";
import { Spinner } from "@/shared/ui/spinner";
import {
  getProviderIcon,
  formatProviderLabel,
} from "@/shared/ui/icons/ProviderIcons";
import { IconCheck } from "@tabler/icons-react";
import {
  authenticateModelProvider,
  onModelSetupOutput,
} from "@/features/providers/api/modelSetup";
import type { ProviderConfigChangeResponseUnstable as ProviderConfigChangeResponse } from "@aaif/goose-sdk";
import type {
  ProviderDisplayInfo,
  ProviderField,
  ProviderFieldValue,
} from "@/shared/types/providers";
import {
  MAX_SETUP_OUTPUT_LINES,
  type SetupOutputLine,
  resolveFieldValue,
  createDraftValues,
  getSetupMessage,
  getNativeConnectDescription,
  getFieldSetupDescription,
  renderSetupMessage,
} from "./modelProviderHelpers";
import {
  ConnectedFieldsPanel,
  ModelRefreshMessage,
  SetupFieldsPanel,
} from "./ModelProviderPanels";
import { ProviderSetupOutput } from "./ProviderSetupOutput";

const INTERNAL_DATABRICKS_PROVIDER_ID = "databricks_v2";
// Mirrors the DATABRICKS_HOST value injected into goose serve by the Tauri backend.
// Keep in sync with src-tauri/src/services/acp/goose_serve.rs.
const INTERNAL_DATABRICKS_HOST =
  "https://block-lakehouse-production.cloud.databricks.com";

interface ProviderFieldSaveInput {
  key: string;
  value: string;
  isSecret: boolean;
}

interface ModelProviderRowProps {
  provider: ProviderDisplayInfo;
  onGetConfig: (providerId: string) => Promise<ProviderFieldValue[]>;
  onSaveFields: (fields: ProviderFieldSaveInput[]) => Promise<void>;
  onRemoveConfig?: () => Promise<void>;
  onCompleteNativeSetup: (
    providerId: string,
    result?: ProviderConfigChangeResponse,
  ) => Promise<void>;
  saving?: boolean;
  modelSyncing?: boolean;
  modelWarning?: string | null;
}

function InternalDatabricksDetails({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2.5">
      <div className="space-y-1 rounded bg-background px-2.5 py-2">
        <p className="text-sm">{label}</p>
        <p className="truncate text-xs text-muted-foreground">
          {INTERNAL_DATABRICKS_HOST}
        </p>
      </div>
    </div>
  );
}

export function ModelProviderRow({
  provider,
  onGetConfig,
  onSaveFields,
  onRemoveConfig,
  onCompleteNativeSetup,
  saving = false,
  modelSyncing = false,
  modelWarning = null,
}: ModelProviderRowProps) {
  const { t } = useTranslation("settings");
  const [expanded, setExpanded] = useState(false);
  const [configValues, setConfigValues] = useState<ProviderFieldValue[]>([]);
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [error, setError] = useState("");
  const [authenticating, setAuthenticating] = useState(false);
  const [setupOutput, setSetupOutput] = useState<SetupOutputLine[]>([]);
  const [setupError, setSetupError] = useState("");
  const [showSavedState, setShowSavedState] = useState(false);
  const setupLineCounter = useRef(0);
  const hasLoadedConfig = useRef(false);
  const shouldRestorePanelFocus = useRef(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const icon = getProviderIcon(provider.id, "size-4");
  const fields = provider.fields ?? [];
  const hasFields = fields.length > 0;
  const supportsNativeConnect = !!provider.nativeConnectQuery;
  const isInternalDatabricks = provider.id === INTERNAL_DATABRICKS_PROVIDER_ID;
  const isConnected =
    provider.status === "connected" || provider.status === "built_in";
  const fieldValueMap = useMemo(
    () => new Map(configValues.map((value) => [value.key, value])),
    [configValues],
  );

  const loadConfig = useCallback(
    async ({ showSkeleton = false }: { showSkeleton?: boolean } = {}) => {
      if (!hasFields) return;
      if (showSkeleton) {
        setLoadingConfig(true);
      }
      try {
        const nextValues = await onGetConfig(provider.id);
        hasLoadedConfig.current = true;
        setConfigValues(nextValues);
        setDraftValues(createDraftValues(fields, nextValues));
        setError("");
      } catch (nextError) {
        setError(
          formatAcpErrorMessage(nextError, "Couldn't load provider settings"),
        );
      } finally {
        if (showSkeleton) {
          setLoadingConfig(false);
        }
      }
    },
    [fields, hasFields, onGetConfig, provider.id],
  );

  useEffect(() => {
    if (expanded && hasFields) {
      void loadConfig({ showSkeleton: !hasLoadedConfig.current });
    }
  }, [expanded, hasFields, loadConfig]);

  useEffect(() => {
    if (isConnected) {
      setAuthenticating(false);
      setSetupError("");
    }
  }, [isConnected]);

  useLayoutEffect(() => {
    if (!shouldRestorePanelFocus.current) {
      return;
    }

    shouldRestorePanelFocus.current = false;
    panelRef.current?.focus({ preventScroll: true });
  });

  function appendSetupOutput(line: string) {
    setupLineCounter.current += 1;
    setSetupOutput((current) =>
      [
        ...current,
        {
          id: setupLineCounter.current,
          text: line,
        },
      ].slice(-MAX_SETUP_OUTPUT_LINES),
    );
  }

  async function runNativeConnect() {
    if (!provider.nativeConnectQuery) {
      return;
    }

    setExpanded(true);
    setAuthenticating(true);
    setSetupError("");
    setSetupOutput([]);
    setEditingKey(null);
    setError("");
    setShowSavedState(false);

    const unlisten = await onModelSetupOutput(provider.id, appendSetupOutput);

    try {
      const result = await authenticateModelProvider(
        provider.id,
        provider.nativeConnectQuery,
      );
      await onCompleteNativeSetup(provider.id, result);
    } catch (nextError) {
      setSetupError(
        formatAcpErrorMessage(nextError, "Couldn't complete sign-in"),
      );
    } finally {
      unlisten();
      setAuthenticating(false);
    }
  }

  function handleToggle() {
    setExpanded((current) => {
      if (current) {
        setShowSavedState(false);
      }
      return !current;
    });
    setEditingKey(null);
    setError("");
    setSetupError("");
  }

  function handleStartEdit(key: string) {
    setEditingKey(key);
    setError("");
    setShowSavedState(false);
  }

  function handleCancelEdit(field: ProviderField) {
    setDraftValues((current) => ({
      ...current,
      [field.key]: field.secret
        ? ""
        : (resolveFieldValue(field, fieldValueMap).value ?? ""),
    }));
    setEditingKey(null);
    setError("");
  }

  function handleDraftChange(key: string, value: string) {
    setShowSavedState(false);
    setDraftValues((current) => ({ ...current, [key]: value }));
  }

  async function handleSaveField(field: ProviderField) {
    const nextValue = draftValues[field.key]?.trim() ?? "";
    if (!nextValue) {
      setError(`Enter a value for ${field.label}`);
      return;
    }
    setError("");
    try {
      shouldRestorePanelFocus.current = true;
      await onSaveFields([
        { key: field.key, value: nextValue, isSecret: field.secret },
      ]);
      await loadConfig();
      setEditingKey(null);
      setShowSavedState(true);
    } catch (nextError) {
      setError(formatAcpErrorMessage(nextError, "Couldn't save"));
    }
  }

  async function handleSaveSetup() {
    const missingLabels = fields
      .filter((field) => {
        if (!field.required) {
          return false;
        }
        const currentValue = resolveFieldValue(field, fieldValueMap);
        const nextValue = draftValues[field.key]?.trim() ?? "";
        return !currentValue.isSet && !nextValue;
      })
      .map((field) => field.label);

    if (missingLabels.length > 0) {
      setError(`Fill in ${missingLabels.join(", ")}`);
      return;
    }

    const fieldsToSave = fields.filter((field) => {
      const currentValue = resolveFieldValue(field, fieldValueMap);
      const nextValue = draftValues[field.key]?.trim() ?? "";

      if (!nextValue) {
        return false;
      }

      if (field.secret) {
        return true;
      }

      return nextValue !== (currentValue.value ?? "");
    });

    if (fieldsToSave.length === 0) {
      setError("");
      return;
    }

    setError("");
    try {
      await onSaveFields(
        fieldsToSave.map((field) => ({
          key: field.key,
          value: draftValues[field.key]?.trim() ?? "",
          isSecret: field.secret,
        })),
      );
      await loadConfig();
      setShowSavedState(false);
    } catch (nextError) {
      setError(formatAcpErrorMessage(nextError, "Couldn't save"));
    }
  }

  async function handleRemove() {
    try {
      shouldRestorePanelFocus.current = true;
      await onRemoveConfig?.();
      await loadConfig();
      setEditingKey(null);
      setError("");
      setShowSavedState(false);
    } catch (nextError) {
      setError(formatAcpErrorMessage(nextError, "Couldn't remove"));
    }
  }

  function renderExpandedContent() {
    if (!expanded) return null;

    const setupMessage = getSetupMessage(
      provider.setupMethod,
      isConnected,
      supportsNativeConnect,
      t,
    );
    const nativeConnectDescription = getNativeConnectDescription(
      provider.setupMethod,
      t,
    );
    const fieldSetupDescription = getFieldSetupDescription(
      provider.setupMethod,
      t,
      provider.fields,
    );

    if (loadingConfig && hasFields) {
      return (
        <div
          ref={panelRef}
          tabIndex={-1}
          className="focus-override mx-3 space-y-3 rounded-b-lg border-x border-b px-3 py-3 outline-none"
        >
          <Skeleton className="h-12 w-full rounded-md" />
          <Skeleton className="h-12 w-full rounded-md" />
        </div>
      );
    }

    if (supportsNativeConnect && !hasFields) {
      return (
        <div
          ref={panelRef}
          tabIndex={-1}
          className="focus-override mx-3 space-y-3 rounded-b-lg border-x border-b px-3 py-3 outline-none"
        >
          {!isConnected && nativeConnectDescription ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {nativeConnectDescription}
              </p>
              <Button
                type="button"
                size="sm"
                onClick={() => void runNativeConnect()}
                disabled={authenticating}
                className="shrink-0"
              >
                {authenticating ? (
                  <Spinner className="size-3.5 text-current" />
                ) : null}
                {setupError ? "Retry" : "Connect"}
              </Button>
            </div>
          ) : (
            <>
              {isInternalDatabricks ? (
                <InternalDatabricksDetails
                  label={t("providers.models.details.configuredUrl")}
                />
              ) : null}
              {renderSetupMessage(setupMessage)}
            </>
          )}
          {authenticating ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5 text-primary" />
              <span>{t("providers.waitingForSignIn")}</span>
            </div>
          ) : null}
          <ModelRefreshMessage syncing={modelSyncing} warning={modelWarning} />
          <ProviderSetupOutput lines={setupOutput} />
          {setupError ? (
            <p className="text-xs text-destructive">{setupError}</p>
          ) : null}
        </div>
      );
    }

    if (hasFields && isConnected) {
      return (
        <ConnectedFieldsPanel
          panelRef={panelRef}
          fields={fields}
          fieldValueMap={fieldValueMap}
          editingKey={editingKey}
          draftValues={draftValues}
          saving={saving}
          modelSyncing={modelSyncing}
          modelWarning={modelWarning}
          showSavedState={showSavedState}
          error={error}
          setupMessage={setupMessage}
          onStartEdit={handleStartEdit}
          onCancelEdit={handleCancelEdit}
          onDraftChange={handleDraftChange}
          onSaveField={(field) => void handleSaveField(field)}
          onRemove={() => void handleRemove()}
        />
      );
    }

    if (hasFields) {
      return (
        <SetupFieldsPanel
          panelRef={panelRef}
          fields={fields}
          fieldValueMap={fieldValueMap}
          draftValues={draftValues}
          saving={saving}
          modelSyncing={modelSyncing}
          modelWarning={modelWarning}
          showSavedState={showSavedState}
          error={error}
          setupMethod={provider.setupMethod}
          setupMessage={setupMessage}
          fieldSetupDescription={fieldSetupDescription}
          isConnected={isConnected}
          onDraftChange={handleDraftChange}
          onSaveSetup={() => void handleSaveSetup()}
        />
      );
    }

    return (
      <div
        ref={panelRef}
        tabIndex={-1}
        className="focus-override mx-3 space-y-2 rounded-b-lg border-x border-b px-3 py-3 outline-none"
      >
        {renderSetupMessage(setupMessage)}
        <ModelRefreshMessage syncing={modelSyncing} warning={modelWarning} />
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={expanded}
        disabled={authenticating}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:hover:bg-transparent"
      >
        {icon ? (
          <div className="flex size-6 flex-shrink-0 items-center justify-center">
            {icon}
          </div>
        ) : (
          <div className="flex size-6 flex-shrink-0 items-center justify-center">
            <span className="text-xs font-medium text-muted-foreground">
              {formatProviderLabel(provider.id).charAt(0)}
            </span>
          </div>
        )}

        <span className="min-w-0 flex-1 text-sm">{provider.displayName}</span>

        {isConnected ? (
          <IconCheck className="size-4 flex-shrink-0 text-success" />
        ) : null}
        {modelSyncing ? (
          <Spinner className="size-3.5 flex-shrink-0 text-primary" />
        ) : null}
        {!isConnected && authenticating ? (
          <Spinner className="size-3.5 flex-shrink-0 text-primary" />
        ) : null}
      </button>

      {renderExpandedContent()}
    </div>
  );
}
