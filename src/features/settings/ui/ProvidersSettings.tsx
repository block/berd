import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Spinner } from "@/shared/ui/spinner";
import { IconCheck, IconChevronDown } from "@tabler/icons-react";
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
  listProviderSetupCatalog,
  selectByoKeyProviders,
} from "@/features/providers/api/catalog";
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
import { ModelProviderRow } from "./ModelProviderRow";
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
): ProviderSetupStatus {
  if (entry.id === "goose") return "built_in";
  if (entry.category === "agent") {
    return entry.setupMethod === "none" ? "built_in" : "not_installed";
  }
  if (configuredIds.has(entry.id)) return "connected";
  return "not_configured";
}

function toDisplayInfo(
  entries: ProviderCatalogEntry[],
  configuredIds: Set<string>,
): ProviderDisplayInfo[] {
  return entries.map((entry) => ({
    ...entry,
    status: resolveStatus(entry, configuredIds),
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

export function ProvidersSettings({
  onStartTroubleshootingChat,
  onReturnToAgentDraft,
}: ProvidersSettingsProps) {
  const { t } = useTranslation(["settings", "common"]);
  const runtimeConfig = useRuntimeConfigStore((state) => state.config);
  const [showAllModels, setShowAllModels] = useState(false);
  const [modelOrder, setModelOrder] = useState<string[] | null>(null);
  const [setupDetourReadyProviderId, setSetupDetourReadyProviderId] = useState<
    string | null
  >(null);
  const catalogEntries = useProviderCatalogStore((state) => state.entries);
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

  useEffect(() => {
    if (!byoEnabled) {
      return;
    }
    void (async () => {
      try {
        useProviderCatalogStore
          .getState()
          .mergeEntries(
            selectByoKeyProviders(await listProviderSetupCatalog()),
          );
      } catch (error) {
        console.warn("Failed to load BYO model providers:", error);
      }
    })();
  }, [byoEnabled]);

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
  } = useCredentials();

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
      ),
    [configuredIds, catalogEntries],
  );

  const allModels = useMemo(
    () =>
      toDisplayInfo(
        filterModelProvidersForRuntimeConfig(
          getModelProvidersFromEntries(catalogEntries),
          runtimeConfig,
        ).filter((provider) => provider.customProvider !== true),
        configuredIds,
      ),
    [configuredIds, runtimeConfig, catalogEntries],
  );

  const sortedModels = useMemo(() => {
    return [...allModels].sort((a, b) => {
      const connected = (p: ProviderDisplayInfo) =>
        p.status === "connected" || p.status === "built_in";
      if (connected(a) && !connected(b)) return -1;
      if (!connected(a) && connected(b)) return 1;
      return 0;
    });
  }, [allModels]);

  useEffect(() => {
    if (!loading && modelOrder === null) {
      setModelOrder(sortedModels.map((model) => model.id));
    }
  }, [loading, modelOrder, sortedModels]);

  const orderedModels = useMemo(() => {
    if (!modelOrder) {
      return sortedModels;
    }

    const orderIndex = new Map(
      modelOrder.map((modelId, index) => [modelId, index]),
    );

    return [...allModels].sort((a, b) => {
      const aIndex = orderIndex.get(a.id);
      const bIndex = orderIndex.get(b.id);

      if (aIndex !== undefined && bIndex !== undefined) {
        return aIndex - bIndex;
      }
      if (aIndex !== undefined) {
        return -1;
      }
      if (bIndex !== undefined) {
        return 1;
      }
      return a.displayName.localeCompare(b.displayName);
    });
  }, [allModels, modelOrder, sortedModels]);

  const defaultModels = orderedModels.filter((m) => m.group === "default");
  const additionalModels = orderedModels.filter(
    (m) => m.group === "additional",
  );
  const visibleModels = showAllModels ? orderedModels : defaultModels;
  const connectedModels = orderedModels.filter(
    (model) => model.status === "connected" || model.status === "built_in",
  );
  const connectedModelNames = connectedModels
    .map((model) => model.displayName)
    .join(", ");
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

  const gooseStatusIndicator =
    connectedModels.length > 0 ? (
      <div className="flex h-6 shrink-0 items-center">
        <IconCheck className="size-4 text-success" />
      </div>
    ) : (
      <span className="shrink-0 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
        {t("providers.models.connectPrompt")}
      </span>
    );

  const gooseCollapsedSupplement = connectedModelNames ? (
    <div className="rounded-b-md bg-foreground px-3 pt-8 pb-2.5 text-background">
      <p className="flex min-w-0 items-baseline gap-2 text-sm leading-5">
        <span className="shrink-0 text-background/70">
          {t(
            connectedModels.length > 1
              ? "providers.models.summaryLabelPlural"
              : "providers.models.summaryLabel",
          )}
        </span>
        <span className="min-w-0 truncate text-background">
          {connectedModelNames}
        </span>
      </p>
    </div>
  ) : null;

  // The model-provider list only powers the goose harness, so it renders
  // inside the goose card's expandable region instead of a sibling section.
  const modelProvidersContent = (
    <div className="border-t pt-3">
      <div className="flex items-center gap-2">
        <h5 className="text-sm text-foreground">
          {t("providers.models.title")}
        </h5>
        {loading ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner className="size-3 text-primary" />
            {t("providers.models.checkingStatus")}
          </span>
        ) : null}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {t("providers.models.description")}
      </p>

      {customProviderError ? (
        <p
          role="alert"
          className="mt-3 rounded-sm border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {customProviderError}
        </p>
      ) : null}

      <div className="mt-3 space-y-2">
        {visibleModels.map((model) => (
          <ModelProviderRow
            key={model.id}
            provider={model}
            onGetConfig={getConfig}
            onSaveFields={(fields) => save(model.id, fields)}
            onRemoveConfig={() => remove(model.id)}
            onCompleteNativeSetup={completeNativeSetup}
            onProviderConnected={handleProviderConnected}
            saving={savingProviderIds.has(model.id)}
            modelSyncing={syncingProviderIds.has(model.id)}
            modelWarning={modelWarnings.get(model.id)}
          />
        ))}
        {byoEnabled
          ? customProviders.map((provider) => (
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
            ))
          : null}
      </div>

      {byoEnabled ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={openAddCustomProvider}
          leftIcon={<IconPlus className="size-3" />}
          className="mt-2 w-full text-muted-foreground"
        >
          {t("providers.custom.addButton")}
        </Button>
      ) : null}

      {!showAllModels && additionalModels.length > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowAllModels(true)}
          className="mt-2 w-full text-muted-foreground"
        >
          {t("providers.showMore", { count: additionalModels.length })}
          <IconChevronDown className="size-3" />
        </Button>
      )}

      {showAllModels && additionalModels.length > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowAllModels(false)}
          className="mt-2 w-full text-muted-foreground"
        >
          {t("providers.showFewer")}
        </Button>
      )}
    </div>
  );

  return (
    <SettingsPage>
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

        <div className="flex flex-col gap-3">
          {agents.map((agent) => (
            <AgentProviderCard
              key={agent.id}
              provider={agent}
              readiness={agentReadiness.get(agent.id)}
              versionCheck={agentChecks.get(agent.id)}
              statusLoading={agentStatusRefreshing}
              onStartTroubleshootingChat={onStartTroubleshootingChat}
              onProviderReady={handleProviderConnected}
              expandedContent={
                agent.id === "goose" ? modelProvidersContent : undefined
              }
              collapsedSupplement={
                agent.id === "goose" ? gooseCollapsedSupplement : undefined
              }
              statusIndicator={
                agent.id === "goose" ? gooseStatusIndicator : undefined
              }
            />
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
            onOpenChange={setCustomDialogOpen}
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
