import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { Button } from "@/shared/ui/button";
import { Collapsible } from "@/shared/ui/collapsible";
import { CollapseReveal } from "@/shared/ui/collapse-reveal";
import { Skeleton } from "@/shared/ui/skeleton";
import { Spinner } from "@/shared/ui/spinner";
import {
  getProviderIcon,
  formatProviderLabel,
} from "@/shared/ui/icons/ProviderIcons";
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
} from "@tabler/icons-react";
import { useModelSetupStore } from "@/features/providers/stores/modelSetupStore";
import type { ProviderConfigChangeResponseUnstable as ProviderConfigChangeResponse } from "@aaif/goose-sdk";
import type {
  ProviderDisplayInfo,
  ProviderField,
  ProviderFieldValue,
} from "@/shared/types/providers";
import {
  resolveFieldValue,
  createDraftValues,
  getSetupMessage,
  getNativeConnectDescription,
  getFieldSetupDescription,
  renderSetupMessage,
} from "@/features/settings/ui/modelProviderHelpers";
import {
  ConnectedFieldsPanel,
  ModelRefreshMessage,
  SetupFieldsPanel,
} from "@/features/settings/ui/ModelProviderPanels";
import { ProviderSetupOutput } from "@/features/settings/ui/ProviderSetupOutput";

const INTERNAL_DATABRICKS_PROVIDER_ID = "databricks_v2";
const DATABRICKS_HOST_ENV_KEY = "DATABRICKS_HOST";
const PROVIDER_CONFIG_LOADING_TIMEOUT_MS = 3000;

// The org-managed Databricks host, when the runtime config injects one into
// `goose serve` (see apply_runtime_goose_provider_env in
// src-tauri/src/services/acp/goose_serve.rs). Present on internal/managed
// builds; absent on external builds, where the same card exposes the editable
// DATABRICKS_HOST field instead (mergeRuntimeProviderCatalog).
function useInjectedDatabricksHost(): string | null {
  return useRuntimeConfigStore(
    (state) =>
      state.config.goose.modelProviders.find(
        (provider) => provider.id === INTERNAL_DATABRICKS_PROVIDER_ID,
      )?.endpointEnv?.[DATABRICKS_HOST_ENV_KEY] ?? null,
  );
}

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
  onProviderConnected?: (providerId: string) => void;
  saving?: boolean;
  modelSyncing?: boolean;
  modelWarning?: string | null;
  defaultExpanded?: boolean;
  collapseSignal?: number;
}

function InternalDatabricksDetails({
  label,
  host,
}: {
  label: string;
  host: string;
}) {
  return (
    <div className="py-2.5">
      <div className="space-y-1 py-2">
        <p className="text-sm">{label}</p>
        <p className="truncate text-sm text-muted-foreground">{host}</p>
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
  onProviderConnected,
  saving = false,
  modelSyncing = false,
  modelWarning = null,
  defaultExpanded = false,
  collapseSignal,
}: ModelProviderRowProps) {
  const { t } = useTranslation("settings");
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [configValues, setConfigValues] = useState<ProviderFieldValue[]>([]);
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(
    () => defaultExpanded && (provider.fields?.length ?? 0) > 0,
  );
  const [error, setError] = useState("");
  const [showSavedState, setShowSavedState] = useState(false);
  const hasLoadedConfig = useRef(false);
  const configLoadRunId = useRef(0);
  const dirtyDraftKeys = useRef(new Set<string>());
  const lastCollapseSignal = useRef(collapseSignal);
  const shouldRestorePanelFocus = useRef(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const contentRegionId = useId();

  // Native sign-in progress is backend-owned: read the latest snapshot from the
  // store (kept current by the app-level `model-setup:state` listener) so this
  // row is a pure view that rehydrates on remount and survives a full window
  // reload — the `goose configure` flow keeps running on the backend regardless
  // of which row is mounted.
  const operation = useModelSetupStore((state) =>
    state.operations.get(provider.id),
  );
  const startSetup = useModelSetupStore((state) => state.startSetup);
  const setOperation = useModelSetupStore((state) => state.setOperation);
  const clearSetupStatus = useModelSetupStore((state) => state.clear);

  // Keep the spinner up while we run the (frontend-only) post-success refresh
  // (`onCompleteNativeSetup` re-reads provider status over ACP), so the row
  // doesn't flash back to "Connect" between the backend reporting success and
  // the connected state landing.
  const [finalizing, setFinalizing] = useState(false);
  const reportedRef = useRef(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const outputLengthRef = useRef(0);

  const status = operation?.status;
  const isRunning = status === "running";
  const authenticating = isRunning || finalizing;
  const setupOutputLines = operation?.output ?? [];
  // Failure surface, derived from the store's raw error (the backend reports the
  // raw `goose configure` failure verbatim).
  const setupError =
    status === "failed"
      ? (operation?.error ?? "Couldn't complete sign-in")
      : "";

  const icon = getProviderIcon(provider.id, "size-4");
  const fields = provider.fields ?? [];
  const hasFields = fields.length > 0;
  const supportsNativeConnect = !!provider.nativeConnectQuery;
  // Only shown when the runtime config actually injects a managed host;
  // external builds have no injected host and get the editable field instead.
  const injectedDatabricksHost = useInjectedDatabricksHost();
  const showInternalDatabricksDetails =
    provider.id === INTERNAL_DATABRICKS_PROVIDER_ID &&
    injectedDatabricksHost != null;
  const isConnected =
    provider.status === "connected" || provider.status === "built_in";
  const fieldValueMap = useMemo(
    () => new Map(configValues.map((value) => [value.key, value])),
    [configValues],
  );

  const loadConfig = useCallback(
    async ({ showSkeleton = false }: { showSkeleton?: boolean } = {}) => {
      if (!hasFields) return;
      const runId = configLoadRunId.current + 1;
      configLoadRunId.current = runId;
      let timeoutId: number | null = null;

      if (showSkeleton) {
        setLoadingConfig(true);
        timeoutId = window.setTimeout(() => {
          if (configLoadRunId.current !== runId) return;
          hasLoadedConfig.current = true;
          setDraftValues((current) =>
            Object.keys(current).length > 0
              ? current
              : createDraftValues(fields, []),
          );
          setError(t("providers.models.setup.configLoadFallback"));
          setLoadingConfig(false);
        }, PROVIDER_CONFIG_LOADING_TIMEOUT_MS);
      }

      try {
        const nextValues = await onGetConfig(provider.id);
        if (configLoadRunId.current !== runId) return;
        hasLoadedConfig.current = true;
        setConfigValues(nextValues);
        setDraftValues((current) => {
          const nextDrafts = createDraftValues(fields, nextValues);
          if (dirtyDraftKeys.current.size === 0) return nextDrafts;

          return fields.reduce<Record<string, string>>((drafts, field) => {
            drafts[field.key] = dirtyDraftKeys.current.has(field.key)
              ? (current[field.key] ?? nextDrafts[field.key] ?? "")
              : (nextDrafts[field.key] ?? "");
            return drafts;
          }, {});
        });
        setError("");
      } catch (nextError) {
        if (configLoadRunId.current !== runId) return;
        setError(
          formatAcpErrorMessage(nextError, "Couldn't load provider settings"),
        );
      } finally {
        if (timeoutId != null) {
          window.clearTimeout(timeoutId);
        }
        if (showSkeleton && configLoadRunId.current === runId) {
          setLoadingConfig(false);
        }
      }
    },
    [fields, hasFields, onGetConfig, provider.id, t],
  );

  useEffect(() => {
    if (expanded && hasFields) {
      void loadConfig({ showSkeleton: !hasLoadedConfig.current });
    }
  }, [expanded, hasFields, loadConfig]);

  useEffect(() => {
    if (collapseSignal === undefined) return;
    if (lastCollapseSignal.current === collapseSignal) return;

    lastCollapseSignal.current = collapseSignal;
    setExpanded(false);
    setShowSavedState(false);
  }, [collapseSignal]);

  // When the backend reports the sign-in succeeded, run the frontend-only
  // refresh the backend can't (re-read provider status over ACP + refresh
  // models), exactly once, then clear the terminal entry so it doesn't
  // re-trigger on a later remount.
  useEffect(() => {
    if (status !== "succeeded") {
      reportedRef.current = false;
      return;
    }
    if (reportedRef.current) return;
    reportedRef.current = true;

    const succeededOperation = operation;
    setFinalizing(true);
    void (async () => {
      try {
        await onCompleteNativeSetup(provider.id);
        onProviderConnected?.(provider.id);
        clearSetupStatus(provider.id);
      } catch (nextError) {
        const message = formatAcpErrorMessage(
          nextError,
          "Couldn't refresh provider status",
        );
        console.error("Failed to finalize model provider sign-in:", nextError);
        setOperation(provider.id, {
          phase: "idle",
          status: "failed",
          output: succeededOperation?.output ?? [],
          error: message,
        });
      } finally {
        setFinalizing(false);
      }
    })();
  }, [
    status,
    operation,
    provider.id,
    onCompleteNativeSetup,
    onProviderConnected,
    setOperation,
    clearSetupStatus,
  ]);

  // A provider that became connected through another path shouldn't keep
  // showing a stale terminal error; drop a lingering failed entry once it's
  // connected (running entries are left to finish).
  useEffect(() => {
    if (isConnected && status === "failed") {
      clearSetupStatus(provider.id);
    }
  }, [isConnected, status, provider.id, clearSetupStatus]);

  useEffect(() => {
    if (
      outputRef.current &&
      outputLengthRef.current !== setupOutputLines.length
    ) {
      outputLengthRef.current = setupOutputLines.length;
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  });

  useLayoutEffect(() => {
    if (!shouldRestorePanelFocus.current) {
      return;
    }

    shouldRestorePanelFocus.current = false;
    panelRef.current?.focus({ preventScroll: true });
  });

  function runNativeConnect() {
    if (!provider.nativeConnectQuery) {
      return;
    }

    setExpanded(true);
    setEditingKey(null);
    setError("");
    setShowSavedState(false);

    // Kick off the backend-owned `goose configure` sign-in; the store mirrors
    // its progress and the success effect runs the post-success refresh. The
    // operation keeps running (and is observable) even if this row unmounts or
    // the window reloads.
    void startSetup(provider.id, {
      providerLabel: provider.nativeConnectQuery,
    });
  }

  function handleExpandedChange(nextExpanded: boolean) {
    if (!nextExpanded) {
      setShowSavedState(false);
    }
    if (nextExpanded && hasFields && !hasLoadedConfig.current) {
      setLoadingConfig(true);
    }
    setExpanded(nextExpanded);
    setEditingKey(null);
    setError("");
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
    dirtyDraftKeys.current.delete(field.key);
    setEditingKey(null);
    setError("");
  }

  function handleDraftChange(key: string, value: string) {
    dirtyDraftKeys.current.add(key);
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
      dirtyDraftKeys.current.delete(field.key);
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
      fieldsToSave.forEach((field) => {
        dirtyDraftKeys.current.delete(field.key);
      });
      void loadConfig();
      onProviderConnected?.(provider.id);
      setShowSavedState(false);
    } catch (nextError) {
      setError(formatAcpErrorMessage(nextError, "Couldn't save"));
    }
  }

  async function handleRemove() {
    try {
      shouldRestorePanelFocus.current = true;
      await onRemoveConfig?.();
      dirtyDraftKeys.current.clear();
      setConfigValues([]);
      setDraftValues(createDraftValues(fields, []));
      await loadConfig();
      setEditingKey(null);
      setError("");
      setShowSavedState(false);
    } catch (nextError) {
      setError(formatAcpErrorMessage(nextError, "Couldn't remove"));
    }
  }

  const fieldSetupDescription = getFieldSetupDescription(
    provider.setupMethod,
    t,
    provider.fields,
  );

  function renderExpandedContent() {
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
    if (loadingConfig && hasFields) {
      return (
        <div
          ref={panelRef}
          tabIndex={-1}
          className="focus-override space-y-3 pt-3 pb-3 outline-none"
        >
          <Skeleton className="h-4 w-1/2 rounded-sm" />
          {fields.map((field) => (
            <Skeleton key={field.key} className="h-12 w-full rounded-sm" />
          ))}
        </div>
      );
    }

    if (supportsNativeConnect && !hasFields) {
      return (
        <div
          ref={panelRef}
          tabIndex={-1}
          className="focus-override space-y-3 pt-3 pb-3 outline-none"
        >
          {!isConnected && nativeConnectDescription ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
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
              {showInternalDatabricksDetails && injectedDatabricksHost ? (
                <InternalDatabricksDetails
                  label={t("providers.models.details.configuredUrl")}
                  host={injectedDatabricksHost}
                />
              ) : null}
              {renderSetupMessage(setupMessage)}
            </>
          )}
          {authenticating ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-3.5 text-primary" />
              <span>{t("providers.waitingForSignIn")}</span>
            </div>
          ) : null}
          <ModelRefreshMessage syncing={modelSyncing} warning={modelWarning} />
          <ProviderSetupOutput
            lines={setupOutputLines.map((text, index) => ({ id: index, text }))}
            scrollRef={outputRef}
          />
          {setupError ? (
            <p className="text-sm text-destructive">{setupError}</p>
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
          onDraftChange={handleDraftChange}
          onSaveSetup={() => void handleSaveSetup()}
        />
      );
    }

    return (
      <div
        ref={panelRef}
        tabIndex={-1}
        className="focus-override space-y-2 pt-3 pb-3 outline-none"
      >
        {renderSetupMessage(setupMessage)}
        <ModelRefreshMessage syncing={modelSyncing} warning={modelWarning} />
      </div>
    );
  }

  const descriptionContent =
    !isConnected && fieldSetupDescription ? (
      <p className="pb-4 text-sm text-muted-foreground">
        {fieldSetupDescription}
        {provider.docsUrl ? (
          <>
            {" "}
            <Button
              type="button"
              variant="link"
              onClick={() => void openUrl(provider.docsUrl ?? "")}
              className="inline align-baseline leading-[inherit]"
            >
              {t("providers.getApiKey")}
            </Button>
          </>
        ) : null}
      </p>
    ) : null;

  return (
    <Collapsible open={expanded} onOpenChange={handleExpandedChange}>
      <div className="rounded-sm transition-colors hover:bg-accent focus-within:bg-accent">
        <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] gap-x-3 px-3">
          <button
            type="button"
            aria-controls={contentRegionId}
            aria-expanded={expanded}
            disabled={authenticating}
            onClick={() => handleExpandedChange(!expanded)}
            className="group/model-provider-row col-span-3 -mx-3 grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-3 rounded-sm px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
          >
            <span className="col-start-1 flex size-6 items-center justify-center">
              <span className="flex size-6 items-center justify-center group-hover/model-provider-row:hidden group-focus-visible/model-provider-row:hidden">
                {icon ?? (
                  <span className="text-xs font-medium text-muted-foreground">
                    {formatProviderLabel(provider.id).charAt(0)}
                  </span>
                )}
              </span>
              {expanded ? (
                <IconChevronDown className="hidden size-3 text-muted-foreground group-hover/model-provider-row:block group-focus-visible/model-provider-row:block" />
              ) : (
                <IconChevronRight className="hidden size-3 text-muted-foreground group-hover/model-provider-row:block group-focus-visible/model-provider-row:block" />
              )}
            </span>

            <span className="col-start-2 flex min-w-0 items-baseline gap-2 text-sm">
              <span className="min-w-0 truncate">{provider.displayName}</span>
              {isConnected ? (
                <span className="shrink-0 text-muted-foreground/60">
                  {t("providers.models.active")}
                </span>
              ) : provider.status === "configured" ? (
                <span className="shrink-0 text-muted-foreground/60">
                  {t("providers.models.configured")}
                </span>
              ) : null}
            </span>

            <span className="col-start-3 flex items-center justify-end gap-1.5">
              {!modelSyncing && modelWarning ? (
                <IconAlertTriangle
                  aria-label={t("providers.needsAttention")}
                  className="size-4 flex-shrink-0 text-warning"
                />
              ) : isConnected ? (
                <IconCheck className="size-4 flex-shrink-0 text-success" />
              ) : null}
              {modelSyncing ? (
                <Spinner className="size-3.5 flex-shrink-0 text-primary" />
              ) : null}
              {!isConnected && authenticating ? (
                <Spinner className="size-3.5 flex-shrink-0 text-primary" />
              ) : null}
            </span>
          </button>
          {descriptionContent ? (
            <div className="col-start-2 col-span-2 -mt-2 min-w-0">
              <CollapseReveal
                open={expanded}
                className="[&>div]:[mask-image:linear-gradient(to_bottom,black_calc(100%-12px),transparent)] [&>div]:[mask-repeat:no-repeat]"
              >
                {descriptionContent}
              </CollapseReveal>
            </div>
          ) : null}
        </div>
      </div>

      <div
        id={contentRegionId}
        aria-hidden={!expanded}
        inert={!expanded ? true : undefined}
      >
        <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] gap-x-3 px-3">
          <div className="col-start-2 col-span-2 min-w-0">
            <CollapseReveal open={expanded}>
              {renderExpandedContent()}
            </CollapseReveal>
          </div>
        </div>
      </div>
    </Collapsible>
  );
}
