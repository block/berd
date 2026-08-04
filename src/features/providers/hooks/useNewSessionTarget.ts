import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { checkAllProviderStatus } from "../api/credentials";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";
import { getAgentProvidersFromEntries } from "../providerCatalog";
import { useAgentProviderStatus } from "./useAgentProviderStatus";
import {
  resolveNewSessionTarget,
  type NewSessionTargetRequest,
  type NewSessionTargetResult,
} from "../lib/newSessionTarget";
import { useDefaultProviderReadinessStore } from "../stores/defaultProviderReadinessStore";
import { useProviderCatalogStore } from "../stores/providerCatalogStore";
import { getBuildFeatureState } from "@/shared/profile/buildProfile";
import { resolveSupportedSessionModelPreference } from "../lib/resolveSessionModelPreference";

export interface EnsureNewSessionTargetOptions {
  onUnavailable?: "open_settings" | "silent";
}

export function useNewSessionTarget() {
  const { t } = useTranslation();
  const {
    agentReadiness: cachedAgentReadiness,
    loading: agentReadinessLoading,
    refresh: refreshAgentReadiness,
  } = useAgentProviderStatus();

  return useCallback(
    async (
      request: NewSessionTargetRequest = {},
      options: EnsureNewSessionTargetOptions = {},
    ): Promise<NewSessionTargetResult> => {
      // New-session creation is a correctness boundary. Refresh readiness that
      // has not settled rather than allowing an initial negative cache to
      // strand the user.
      let defaultProviderReadiness =
        useDefaultProviderReadinessStore.getState().readiness;
      let agentReadiness = cachedAgentReadiness;
      const defaultReadinessUnknown =
        defaultProviderReadiness == null ||
        defaultProviderReadiness.status === "unknown";
      if (defaultReadinessUnknown || agentReadinessLoading) {
        const [refreshedDefault, refreshedAgents] = await Promise.all([
          defaultReadinessUnknown
            ? useDefaultProviderReadinessStore.getState().refresh()
            : Promise.resolve(defaultProviderReadiness),
          refreshAgentReadiness(),
        ]);
        defaultProviderReadiness = refreshedDefault ?? defaultProviderReadiness;
        agentReadiness = refreshedAgents ?? cachedAgentReadiness;
      }
      const catalogAgentIds = getAgentProvidersFromEntries(
        useProviderCatalogStore.getState().entries,
      ).map((provider) => provider.id);
      const readyAgentIds = new Set(
        [...agentReadiness.entries()]
          .filter(([, readiness]) => readiness === "ready")
          .map(([providerId]) => providerId),
      );
      let configuredAgentIds = new Set<string>();
      if (
        request.providerId &&
        request.providerId !== "goose" &&
        !readyAgentIds.has(request.providerId)
      ) {
        const statuses = await checkAllProviderStatus();
        configuredAgentIds = new Set(
          statuses
            .filter((status) => status.isConfigured)
            .map((status) => status.providerId),
        );
      }
      let result = resolveNewSessionTarget(
        {
          defaultProviderReadiness,
          readyAgentIds,
          configuredAgentIds,
          catalogAgentIds,
          persistedProviderId: useAgentStore.getState().selectedProvider,
          policy: {
            requireGooseDefaultProvider: getBuildFeatureState().byoKeyProviders,
          },
        },
        request,
      );
      if (
        result.status === "ready" &&
        result.provenance === "persisted" &&
        result.providerId !== "goose" &&
        !result.modelId
      ) {
        result = {
          ...result,
          ...resolveSupportedSessionModelPreference(
            result.providerId,
            undefined,
          ),
        };
      }

      if (result.status !== "ready" && options.onUnavailable !== "silent") {
        toast.info(t("settings:providers.setupRequired.toast"));
        requestOpenSettings("providers");
      }
      return result;
    },
    [agentReadinessLoading, cachedAgentReadiness, refreshAgentReadiness, t],
  );
}
