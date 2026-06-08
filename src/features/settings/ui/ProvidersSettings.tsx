import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Separator } from "@/shared/ui/separator";
import { Spinner } from "@/shared/ui/spinner";
import { IconChevronDown } from "@tabler/icons-react";
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
import { useDistroStore } from "@/features/settings/stores/distroStore";
import { filterModelProvidersForDistro } from "@/features/providers/distroProviderConstraints";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { AgentProviderCard } from "./AgentProviderCard";
import { ModelProviderRow } from "./ModelProviderRow";
import { SettingsPage } from "@/shared/ui/SettingsPage";
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

interface ProvidersSettingsProps {
  onStartTroubleshootingChat?: (
    request: AgentSetupTroubleshootingRequest,
  ) => void;
  onReturnToAgentDraft?: () => void;
}

export function ProvidersSettings({
  onStartTroubleshootingChat,
  onReturnToAgentDraft,
}: ProvidersSettingsProps) {
  const { t } = useTranslation("settings");
  const distro = useDistroStore((state) => state.manifest);
  const [showAllModels, setShowAllModels] = useState(false);
  const [modelOrder, setModelOrder] = useState<string[] | null>(null);
  const [setupDetourReadyProviderId, setSetupDetourReadyProviderId] = useState<
    string | null
  >(null);
  const catalogEntries = useProviderCatalogStore((state) => state.entries);
  const queryClient = useQueryClient();

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
        filterModelProvidersForDistro(
          getModelProvidersFromEntries(catalogEntries),
          distro,
        ),
        configuredIds,
      ),
    [configuredIds, distro, catalogEntries],
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
            {t("doctor.rerun")}
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {agents.map((agent) => (
            <AgentProviderCard
              key={agent.id}
              provider={agent}
              readiness={agentReadiness.get(agent.id)}
              versionCheck={agentChecks.get(agent.id)}
              statusLoading={agentStatusRefreshing}
              onStartTroubleshootingChat={onStartTroubleshootingChat}
              onProviderReady={handleProviderConnected}
            />
          ))}
        </div>
      </section>

      <Separator className="my-6" />

      <section>
        <div className="mb-3">
          <div className="flex items-center gap-2">
            <h4 className="text-base text-foreground">
              {t("providers.models.title")}
            </h4>
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
        </div>

        <div className="space-y-2">
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
        </div>

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
      </section>
    </SettingsPage>
  );
}
