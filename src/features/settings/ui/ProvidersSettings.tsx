import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { RowButton } from "@/shared/ui/row-button";
import { Spinner } from "@/shared/ui/spinner";
import { IconCheck } from "@tabler/icons-react";
import {
  rerunDoctorReport,
  useDoctorReport,
  useDoctorReportFreshnessFetching,
} from "@/shared/api/useDoctorReport";
import {
  getAgentProvidersFromEntries,
  getModelProvidersFromEntries,
} from "@/features/providers/providerCatalog";
import { useCredentials } from "@/features/providers/hooks/useCredentials";
import { useAgentProviderStatus } from "@/features/providers/hooks/useAgentProviderStatus";
import { useCustomProviders } from "@/features/providers/hooks/useCustomProviders";
import {
  listCustomProviders,
  type CustomProviderSummary,
} from "@/features/providers/api/customProviders";
import {
  mergeProviderChoices,
  PROMOTED_PROVIDER_IDS,
  providerDisplayName,
} from "@/features/providers/lib/providerDirectory";
import {
  getCredentialedProviderIds,
  hasMeaningfulSavedSettings,
} from "@/features/providers/lib/providerConnectionPolicy";
import {
  projectModelProviderState,
  type ModelProviderState,
} from "@/features/providers/lib/providerState";
import { listProviderSecrets } from "@/features/providers/api/credentials";
import {
  CustomProviderChoice,
  type CustomProviderChoiceInfo,
} from "@/features/providers/ui/CustomProviderChoice";
import {
  CustomProviderDialog,
  type CustomProviderMutationInput,
} from "@/features/providers/ui/CustomProviderDialog";
import type {
  CustomProviderFormValues,
  ProviderTemplate,
} from "@/features/providers/ui/CustomProviderForm";
import {
  catalogEntryToTemplate,
  formValueToDraft,
  readResponseToFormValue,
  templateToFormValue,
} from "./customProviderFormAdapters";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { IconPlus } from "@tabler/icons-react";
import { getBuildFeatureState } from "@/shared/profile/buildProfile";
import { filterModelProvidersForRuntimeConfig } from "@/features/providers/runtimeProviderConstraints";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { AgentProviderCard } from "./AgentProviderCard";
import { ModelProviderRow } from "@/features/providers/ui/ModelProviderRow";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import type { AgentSetupTroubleshootingRequest } from "@/features/providers/lib/agentSetupTroubleshooting";
import type {
  ProviderDisplayInfo,
  ProviderSetupStatus,
  ProviderCatalogEntry,
} from "@/shared/types/providers";

function resolveStatus(
  entry: ProviderCatalogEntry,
  configuredIds: Set<string>,
  runtimeManagedIds: ReadonlySet<string>,
  credentialedIds: ReadonlySet<string>,
  configuredBySavedValueIds: ReadonlySet<string>,
): ProviderSetupStatus {
  if (entry.id === "goose") return "built_in";
  if (entry.category === "agent") {
    return entry.setupMethod === "none" ? "built_in" : "not_installed";
  }
  return projectModelProviderState(entry, {
    configuredIds,
    credentialedIds,
    runtimeManagedIds,
    configuredBySavedValueIds,
  }).status;
}

function toDisplayInfo(
  entries: ProviderCatalogEntry[],
  configuredIds: Set<string>,
  runtimeManagedIds: ReadonlySet<string>,
  credentialedIds: ReadonlySet<string> = new Set(),
  configuredBySavedValueIds: ReadonlySet<string> = new Set(),
): ProviderDisplayInfo[] {
  return entries.map((entry) => ({
    ...entry,
    status: resolveStatus(
      entry,
      configuredIds,
      runtimeManagedIds,
      credentialedIds,
      configuredBySavedValueIds,
    ),
  }));
}

function customProviderSummaryToCatalogEntry(
  provider: CustomProviderSummary,
): ProviderCatalogEntry {
  return {
    id: provider.providerId,
    displayName: provider.displayName,
    category: "model",
    description: provider.description ?? "Custom model provider",
    setupMethod: "config_fields",
    group: "additional",
    customProvider: true,
    catalogSource: "custom",
    supportsInstall: false,
    supportsAuth: false,
    supportsAuthStatus: false,
  };
}

interface ProvidersSettingsProps {
  onStartTroubleshootingChat?: (
    request: AgentSetupTroubleshootingRequest,
  ) => void;
  onReturnToAgentDraft?: () => void;
}

function toChoiceInfo(
  summary: CustomProviderSummary,
): CustomProviderChoiceInfo {
  return {
    providerId: summary.providerId,
    displayName: summary.displayName,
    description: summary.description,
    configured: summary.configured,
    modelCount: summary.modelCount,
  };
}

interface PendingCustomProviderDelete {
  providerId: string;
  displayName: string;
}

const PROVIDER_STATUS_LOADING_TIMEOUT_MS = 3000;
const PROVIDER_SECRETS_LOADING_TIMEOUT_MS = 3000;

export function ProvidersSettings({
  onStartTroubleshootingChat,
  onReturnToAgentDraft,
}: ProvidersSettingsProps) {
  const { t } = useTranslation(["settings", "common"]);
  const runtimeConfig = useRuntimeConfigStore((state) => state.config);
  const [selectedSetupProviderId, setSelectedSetupProviderId] = useState<
    string | null
  >(null);
  const [modelProviderCollapseSignal, setModelProviderCollapseSignal] =
    useState(0);
  const [setupDetourReadyProviderId, setSetupDetourReadyProviderId] = useState<
    string | null
  >(null);
  const catalogEntries = useProviderCatalogStore((state) => state.entries);
  const runtimeProviderIds = useMemo(
    () => new Set(runtimeConfig.goose.modelProviders.map(({ id }) => id)),
    [runtimeConfig],
  );
  const runtimeManagedIds = useMemo(
    () =>
      new Set(
        runtimeConfig.goose.modelProviders
          .filter((provider) => provider.endpointEnv != null)
          .map((provider) => provider.id),
      ),
    [runtimeConfig],
  );
  const queryClient = useQueryClient();

  // Custom ("Add a provider") state. The whole surface is BYO-gated: with the
  // build feature off, restricted builds keep the allowlist-only page.
  const byoEnabled = getBuildFeatureState().byoKeyProviders;
  const customProvidersApi = useCustomProviders();
  const [customProviders, setCustomProviders] = useState<
    CustomProviderSummary[]
  >([]);
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [customDialogMode, setCustomDialogMode] = useState<"create" | "edit">(
    "create",
  );
  const [customProviderDraft, setCustomProviderDraft] =
    useState<CustomProviderFormValues | null>(null);
  const [customProviderTemplates, setCustomProviderTemplates] = useState<
    ProviderTemplate[]
  >([]);
  const [customProviderError, setCustomProviderError] = useState("");
  const [pendingCustomProviderDelete, setPendingCustomProviderDelete] =
    useState<PendingCustomProviderDelete | null>(null);

  const refreshCustomProviders = useCallback(async () => {
    if (!byoEnabled) {
      return;
    }
    try {
      const providers = await listCustomProviders();
      setCustomProviders(providers);
      useProviderCatalogStore
        .getState()
        .mergeEntries(providers.map(customProviderSummaryToCatalogEntry));
    } catch (error) {
      console.warn("Failed to list custom providers:", error);
    }
  }, [byoEnabled]);

  useEffect(() => {
    void refreshCustomProviders();
  }, [refreshCustomProviders]);

  const loadCustomProviderTemplates = useCallback(async () => {
    try {
      const catalog = await customProvidersApi.loadCatalog();
      const templates = await Promise.all(
        catalog.map(async (entry) => {
          try {
            return templateToFormValue(
              await customProvidersApi.getTemplate(entry.providerId),
            );
          } catch {
            return catalogEntryToTemplate(entry);
          }
        }),
      );
      setCustomProviderTemplates(templates);
    } catch (error) {
      setCustomProviderTemplates([]);
      setCustomProviderError(
        error instanceof Error
          ? error.message
          : t("providers.custom.errors.templatesFailed"),
      );
    }
  }, [customProvidersApi, t]);

  const openAddCustomProvider = useCallback(() => {
    setCustomProviderError("");
    setCustomProviderDraft(null);
    setCustomDialogMode("create");
    setCustomDialogOpen(true);
    void loadCustomProviderTemplates();
  }, [loadCustomProviderTemplates]);

  const openEditCustomProvider = useCallback(
    async (providerId: string) => {
      setCustomProviderError("");
      try {
        const provider = readResponseToFormValue(
          await customProvidersApi.read(providerId),
        );
        setCustomProviderDraft(provider);
        setCustomDialogMode("edit");
        setCustomDialogOpen(true);
        void loadCustomProviderTemplates();
      } catch (error) {
        setCustomProviderError(
          error instanceof Error
            ? error.message
            : t("providers.custom.errors.loadFailed"),
        );
      }
    },
    [customProvidersApi, loadCustomProviderTemplates, t],
  );

  const handleCreateCustomProvider = useCallback(
    async (input: CustomProviderMutationInput) => {
      await customProvidersApi.saveDraft(formValueToDraft(input));
      await refreshCustomProviders();
    },
    [customProvidersApi, refreshCustomProviders],
  );

  const handleUpdateCustomProvider = useCallback(
    async (providerId: string, input: CustomProviderMutationInput) => {
      await customProvidersApi.saveDraft(formValueToDraft(input), {
        providerId,
      });
      await refreshCustomProviders();
    },
    [customProvidersApi, refreshCustomProviders],
  );

  const confirmDeleteCustomProvider = useCallback(async () => {
    const pending = pendingCustomProviderDelete;
    if (!pending) {
      return;
    }
    await customProvidersApi.remove(pending.providerId);
    setPendingCustomProviderDelete(null);
    setCustomDialogOpen(false);
    await refreshCustomProviders();
  }, [customProvidersApi, pendingCustomProviderDelete, refreshCustomProviders]);

  const rerunAgentStatus = useCallback(() => {
    // Bust the shared `["doctor","report"]` query and re-run the freshness
    // pass, so install/auth state + version badges repopulate everywhere
    // reading the report (this page, Doctor, chat picker).
    void rerunDoctorReport(queryClient);
  }, [queryClient]);

  const {
    configuredIds,
    loading,
    savingProviderIds,
    syncingProviderIds,
    modelWarnings,
    getConfig,
    save,
    remove,
    completeNativeSetup,
    credentialRevision,
  } = useCredentials();
  const [credentialStatusLoading, setCredentialStatusLoading] =
    useState(loading);
  useEffect(() => {
    if (!loading) {
      setCredentialStatusLoading(false);
      return;
    }

    setCredentialStatusLoading(true);
    const timeoutId = window.setTimeout(() => {
      setCredentialStatusLoading(false);
    }, PROVIDER_STATUS_LOADING_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [loading]);

  // Agent install/auth status comes from the shared doctor report (the same
  // `["doctor","report"]` query the Doctor page and chat picker read), so the
  // cards paint from the warmed cache instead of each probing on mount.
  const {
    agentReadiness,
    agentChecks,
    loading: agentStatusLoading,
  } = useAgentProviderStatus();
  // `agentStatusLoading` is `isPending` (first-load only). The shared query's
  // `isFetching` tracks the fast `runDoctor` queryFn (covers manual reruns
  // after `invalidateDoctorReport`), and `freshnessFetching` tracks the slower
  // freshness pass driven through React Query as a sibling key. OR all three
  // so the per-card "checking" state and the rerun button stay up until the
  // version / install-source / update badges have actually populated, not
  // just until the fast offline pass returns.
  const doctorReportQuery = useDoctorReport();
  const freshnessFetching = useDoctorReportFreshnessFetching();
  const agentStatusRefreshing =
    agentStatusLoading || doctorReportQuery.isFetching || freshnessFetching;

  const agents = useMemo(
    () =>
      toDisplayInfo(
        getAgentProvidersFromEntries(catalogEntries),
        configuredIds,
        runtimeManagedIds,
      ),
    [configuredIds, catalogEntries, runtimeManagedIds],
  );

  // Stored Goose credentials (API keys / OAuth tokens) are the authoritative
  // Active evidence: one secrets-list call, no per-provider probing.
  const [credentialedIds, setCredentialedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [credentialedIdsLoading, setCredentialedIdsLoading] = useState(true);
  const hasLoadedCredentialedIds = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const revisionAtRequest = credentialRevision;
    const isInitialLoad = !hasLoadedCredentialedIds.current;
    const timeoutId = window.setTimeout(() => {
      if (!cancelled && revisionAtRequest === credentialRevision) {
        hasLoadedCredentialedIds.current = true;
        setCredentialedIdsLoading(false);
      }
    }, PROVIDER_SECRETS_LOADING_TIMEOUT_MS);

    if (isInitialLoad) {
      setCredentialedIdsLoading(true);
    }
    void listProviderSecrets()
      .then((secrets) => {
        if (!cancelled && revisionAtRequest === credentialRevision) {
          setCredentialedIds(getCredentialedProviderIds(secrets));
        }
      })
      .catch(() => {
        if (!cancelled && revisionAtRequest === credentialRevision) {
          // Without secret evidence, stay conservative: no Active promotion.
          setCredentialedIds(new Set());
        }
      })
      .finally(() => {
        window.clearTimeout(timeoutId);
        if (!cancelled && revisionAtRequest === credentialRevision) {
          hasLoadedCredentialedIds.current = true;
          setCredentialedIdsLoading(false);
        }
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [credentialRevision]);

  // A provider without a stored credential can still earn "Configured" when
  // the user saved a meaningful non-secret setting. Untouched defaults or
  // ambient-only readiness never count.
  const [configuredBySavedValueIds, setConfiguredBySavedValueIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const configStatusRunId = useRef(0);
  const nonCredentialConfiguredProviders = useMemo(
    () =>
      getModelProvidersFromEntries(catalogEntries).filter((entry) => {
        if (!configuredIds.has(entry.id) || (entry.fields?.length ?? 0) === 0) {
          return false;
        }
        const state: ModelProviderState = projectModelProviderState(entry, {
          configuredIds,
          credentialedIds,
          runtimeManagedIds,
        });
        return !state.connected;
      }),
    [catalogEntries, configuredIds, runtimeManagedIds, credentialedIds],
  );
  useEffect(() => {
    const runId = configStatusRunId.current + 1;
    configStatusRunId.current = runId;
    const currentIds = new Set(
      nonCredentialConfiguredProviders.map((provider) => provider.id),
    );
    setConfiguredBySavedValueIds(
      (previous) => new Set([...previous].filter((id) => currentIds.has(id))),
    );

    for (const entry of nonCredentialConfiguredProviders) {
      void getConfig(entry.id)
        .then((values) => hasMeaningfulSavedSettings(entry, values))
        .catch(() => false)
        .then((configured) => {
          if (configStatusRunId.current !== runId) return;
          setConfiguredBySavedValueIds((previous) => {
            const next = new Set(previous);
            if (configured) next.add(entry.id);
            else next.delete(entry.id);
            return next;
          });
        });
    }
  }, [nonCredentialConfiguredProviders, getConfig]);

  const allModels = useMemo(
    () =>
      toDisplayInfo(
        filterModelProvidersForRuntimeConfig(
          getModelProvidersFromEntries(catalogEntries),
          runtimeConfig,
        ).filter((provider) => provider.customProvider !== true),
        configuredIds,
        runtimeManagedIds,
        credentialedIds,
        configuredBySavedValueIds,
      ),
    [
      configuredIds,
      runtimeConfig,
      catalogEntries,
      runtimeManagedIds,
      credentialedIds,
      configuredBySavedValueIds,
    ],
  );

  const namedModels = allModels.map((model) => ({
    ...model,
    displayName: providerDisplayName(model.id, model.displayName),
  }));
  const modelById = new Map(namedModels.map((model) => [model.id, model]));
  const promotedModels = PROMOTED_PROVIDER_IDS.flatMap((id) => {
    const model = modelById.get(id);
    return model ? [model] : [];
  });
  const promotedIds = new Set<string>(PROMOTED_PROVIDER_IDS);
  const visibleUnpromotedModels = namedModels.filter(
    (model) =>
      !promotedIds.has(model.id) &&
      (runtimeProviderIds.has(model.id) ||
        model.status === "connected" ||
        model.status === "built_in" ||
        model.status === "configured"),
  );
  const selectedSetupModel = selectedSetupProviderId
    ? namedModels.find((model) => model.id === selectedSetupProviderId)
    : undefined;
  const visibleModels = [...promotedModels, ...visibleUnpromotedModels];
  const mainPageModels = visibleModels.filter(
    (model) => model.id !== selectedSetupProviderId,
  );
  const activeModels = mainPageModels.filter(
    (model) => model.status === "connected" || model.status === "built_in",
  );
  const inactiveModels = mainPageModels.filter(
    (model) => model.status !== "connected" && model.status !== "built_in",
  );
  const activeCustomProviders = customProviders.filter(
    (provider) => provider.configured,
  );
  const inactiveCustomProviders = customProviders.filter(
    (provider) => !provider.configured,
  );
  const directoryChoices = mergeProviderChoices(
    namedModels,
    customProviderTemplates,
  );
  const connectedModels = namedModels.filter(
    (model) => model.status === "connected" || model.status === "built_in",
  );
  const connectedModelNames = connectedModels
    .map((model) => model.displayName)
    .join(", ");
  const modelProviderStatusLoading =
    credentialStatusLoading || credentialedIdsLoading;
  const showSetupDetourReturn =
    Boolean(onReturnToAgentDraft) && Boolean(setupDetourReadyProviderId);

  if (!onReturnToAgentDraft && setupDetourReadyProviderId !== null) {
    setSetupDetourReadyProviderId(null);
  }

  function handleProviderConnected(providerId: string) {
    if (onReturnToAgentDraft) {
      setSetupDetourReadyProviderId(providerId);
    }
  }

  function handleGooseDisclosureOpenChange(open: boolean) {
    if (open) return;
    setSelectedSetupProviderId(null);
    setModelProviderCollapseSignal((signal) => signal + 1);
  }

  const gooseStatusIndicator = modelProviderStatusLoading ? (
    <div className="flex h-6 shrink-0 items-center">
      <Spinner className="size-3.5 text-primary" />
    </div>
  ) : connectedModels.length > 0 ? (
    <div className="flex h-6 shrink-0 items-center">
      <IconCheck className="size-4 text-success" />
    </div>
  ) : (
    <span className="shrink-0 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
      {t("providers.models.connectPrompt")}
    </span>
  );

  function renderModelProvider(model: ProviderDisplayInfo) {
    return (
      <ModelProviderRow
        key={model.id}
        provider={model}
        defaultExpanded={model.id === selectedSetupProviderId}
        onGetConfig={getConfig}
        onSaveFields={(fields) => save(model.id, fields)}
        onRemoveConfig={() => remove(model.id)}
        onCompleteNativeSetup={completeNativeSetup}
        onProviderConnected={handleProviderConnected}
        saving={savingProviderIds.has(model.id)}
        modelSyncing={syncingProviderIds.has(model.id)}
        modelWarning={modelWarnings.get(model.id)}
        collapseSignal={modelProviderCollapseSignal}
      />
    );
  }

  function renderCustomProvider(provider: CustomProviderSummary) {
    return (
      <CustomProviderChoice
        key={provider.providerId}
        provider={toChoiceInfo(provider)}
        onEdit={() => void openEditCustomProvider(provider.providerId)}
        onDelete={() =>
          setPendingCustomProviderDelete({
            providerId: provider.providerId,
            displayName: provider.displayName,
          })
        }
        deleting={customProvidersApi.saving}
      />
    );
  }

  const gooseModelProviderSummary = modelProviderStatusLoading
    ? t("providers.models.checkingStatus")
    : connectedModelNames || t("providers.models.connectPrompt");

  // The model-provider list only powers the goose harness, so it renders
  // inside the goose card's expandable region instead of a sibling section.
  const modelProvidersContent = (
    <div>
      {modelProviderStatusLoading ? (
        <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner className="size-3 text-primary" />
          {t("providers.models.checkingStatus")}
        </p>
      ) : (
        <>
          {customProviderError ? (
            <p
              role="alert"
              className="mb-3 rounded-sm border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {customProviderError}
            </p>
          ) : null}

          <div className="space-y-2">
            {activeModels.map(renderModelProvider)}
            {byoEnabled
              ? activeCustomProviders.map(renderCustomProvider)
              : null}
            {inactiveModels.map(renderModelProvider)}
            {byoEnabled
              ? inactiveCustomProviders.map(renderCustomProvider)
              : null}
          </div>

          {byoEnabled ? (
            <RowButton
              variant="menu"
              onClick={openAddCustomProvider}
              className="mt-2 px-3 py-2.5"
              icon={
                <span className="flex size-6 shrink-0 items-center justify-center">
                  <IconPlus className="size-4 text-muted-foreground" />
                </span>
              }
              label={t("providers.custom.addButton")}
            />
          ) : null}
        </>
      )}
    </div>
  );

  return (
    <SettingsPage title={t("nav.providers")}>
      {showSetupDetourReturn ? (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-card-chat bg-foreground px-3 py-2 text-background">
          <p className="text-xs">
            {t("providers.setupDetour.readyDescription")}
          </p>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={onReturnToAgentDraft}
            className="shrink-0 border-transparent bg-background text-foreground hover:bg-background/90 hover:text-foreground"
          >
            {t("providers.setupDetour.returnToDraft")}
          </Button>
        </div>
      ) : null}

      <section>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h4 className="text-base text-foreground">
              {t("providers.agents.title")}
            </h4>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("providers.agents.description")}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={rerunAgentStatus}
            disabled={agentStatusRefreshing}
            leftIcon={
              agentStatusRefreshing ? (
                <Spinner className="size-3" />
              ) : (
                <RefreshCw className="size-3" />
              )
            }
            className="shrink-0"
          >
            {t("providers.agents.refresh")}
          </Button>
        </div>

        <div>
          {agents.map((agent, index) => (
            <div
              key={agent.id}
              className={
                agent.id === "goose"
                  ? "border-b border-border"
                  : index > 0 && agents[index - 1]?.id !== "goose"
                    ? "border-t border-border"
                    : undefined
              }
            >
              <AgentProviderCard
                provider={agent}
                readiness={agentReadiness.get(agent.id)}
                versionCheck={agentChecks.get(agent.id)}
                statusLoading={agentStatusRefreshing}
                onStartTroubleshootingChat={onStartTroubleshootingChat}
                onProviderReady={handleProviderConnected}
                expandedContent={
                  agent.id === "goose" ? modelProvidersContent : undefined
                }
                expandableLabel={
                  agent.id === "goose" ? t("providers.models.title") : undefined
                }
                collapsedSummary={
                  agent.id === "goose" ? gooseModelProviderSummary : undefined
                }
                statusIndicator={
                  agent.id === "goose" ? gooseStatusIndicator : undefined
                }
                statusIndicatorOpensDetails={
                  agent.id === "goose" &&
                  !modelProviderStatusLoading &&
                  connectedModels.length === 0
                }
                showDisclosure={agent.id === "goose"}
                onDisclosureOpenChange={
                  agent.id === "goose"
                    ? handleGooseDisclosureOpenChange
                    : undefined
                }
              />
            </div>
          ))}
        </div>
      </section>

      {byoEnabled ? (
        <>
          <CustomProviderDialog
            open={customDialogOpen}
            mode={customDialogMode}
            provider={customProviderDraft}
            templates={customProviderTemplates}
            choices={directoryChoices}
            onSelectSetupProvider={setSelectedSetupProviderId}
            directoryLoading={customProvidersApi.catalogLoading}
            setupProviderContent={
              selectedSetupModel ? (
                <ModelProviderRow
                  key={selectedSetupModel.id}
                  provider={selectedSetupModel}
                  defaultExpanded
                  onGetConfig={getConfig}
                  onSaveFields={(fields) => save(selectedSetupModel.id, fields)}
                  onRemoveConfig={() => remove(selectedSetupModel.id)}
                  onCompleteNativeSetup={completeNativeSetup}
                  onProviderConnected={handleProviderConnected}
                  saving={savingProviderIds.has(selectedSetupModel.id)}
                  modelSyncing={syncingProviderIds.has(selectedSetupModel.id)}
                  modelWarning={modelWarnings.get(selectedSetupModel.id)}
                />
              ) : null
            }
            onOpenChange={(open) => {
              setCustomDialogOpen(open);
              if (!open) setSelectedSetupProviderId(null);
            }}
            onCreate={handleCreateCustomProvider}
            onUpdate={handleUpdateCustomProvider}
            onDelete={async (providerId) => {
              const provider = customProviders.find(
                (candidate) => candidate.providerId === providerId,
              );
              setPendingCustomProviderDelete({
                providerId,
                displayName: provider?.displayName ?? providerId,
              });
              // The confirm dialog owns completion; keep the edit dialog open.
              return false;
            }}
          />
          <ConfirmDialog
            open={!!pendingCustomProviderDelete}
            onOpenChange={(open) => {
              if (!open) {
                setPendingCustomProviderDelete(null);
              }
            }}
            title={t("providers.custom.confirmDeleteTitle", {
              name: pendingCustomProviderDelete?.displayName ?? "",
            })}
            description={t("providers.custom.confirmDelete", {
              name: pendingCustomProviderDelete?.displayName ?? "",
            })}
            cancelLabel={t("common:actions.cancel")}
            confirmLabel={t("providers.custom.actions.delete")}
            loadingLabel={t("providers.custom.actions.deleting")}
            isLoading={customProvidersApi.saving}
            onConfirm={confirmDeleteCustomProvider}
            onConfirmError={(error) =>
              setCustomProviderError(
                error instanceof Error
                  ? error.message
                  : t("providers.custom.errors.deleteFailed"),
              )
            }
          />
        </>
      ) : null}
    </SettingsPage>
  );
}
