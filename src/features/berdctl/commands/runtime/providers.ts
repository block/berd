import {
  readinessFromReport,
  type AgentProviderReadiness,
} from "@/features/providers/hooks/useAgentProviderStatus";
import { filterModelProvidersForRuntimeConfig } from "@/features/providers/runtimeProviderConstraints";
import { getProviderModelSelectionHint } from "@/features/providers/modelSelectionHints";
import { getModelProviders } from "@/features/providers/providerCatalog";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { discoverAcpProviders } from "@/shared/api/acp";
import { GOOSE_PROVIDER_ID } from "@/shared/api/acpPersonaHandoff";
import { runDoctor, type DoctorReport } from "@/shared/api/doctor";
import { prefetchDoctorReport } from "@/shared/api/useDoctorReport";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";

import { getBerdctlQueryClient } from "../../bridge/runtimeContext";
import { CommandError } from "../types";

export interface HarnessStatus {
  id: string;
  label: string;
  readiness: AgentProviderReadiness;
}

export interface ModelEntry {
  model_id: string;
  name: string;
  provider?: string;
}

function sharedDoctorReport(): Promise<DoctorReport | null> {
  const queryClient = getBerdctlQueryClient();
  const report = queryClient ? prefetchDoctorReport(queryClient) : runDoctor();
  return report.catch(() => null);
}

export async function listHarnessStatuses(): Promise<HarnessStatus[]> {
  const [harnesses, report] = await Promise.all([
    discoverAcpProviders(),
    sharedDoctorReport(),
  ]);
  const readiness = report ? readinessFromReport(report) : null;
  return harnesses.map((harness) => ({
    id: harness.id,
    label: harness.label,
    readiness: readiness ? (readiness.get(harness.id) ?? "not_ready") : "ready",
  }));
}

export async function findReadyHarnessOrThrow(
  harnessId: string,
): Promise<HarnessStatus> {
  const harnesses = await listHarnessStatuses();
  const match = harnesses.find((harness) => harness.id === harnessId);
  if (!match) {
    throw new CommandError(
      "harness_not_found",
      `No agent harness "${harnessId}". Known: ${harnesses
        .map((harness) => harness.id)
        .join(", ")}`,
    );
  }
  if (match.readiness !== "ready") {
    throw new CommandError(
      "harness_not_ready",
      (match.readiness === "not_installed"
        ? `Agent harness "${harnessId}" is not installed.`
        : `Agent harness "${harnessId}" is not ready (sign-in or setup required).`) +
        ' The user must fix it in the app; pick a "ready" harness from `berdctl info harnesses`.',
    );
  }
  return match;
}

export async function gooseModelOptions(): Promise<ModelEntry[]> {
  const providerIds = filterModelProvidersForRuntimeConfig(
    getModelProviders(),
    useRuntimeConfigStore.getState().config,
  ).map((provider) => provider.id);
  const store = useProviderModelCacheStore.getState();
  await store.refreshAllModelProviders(providerIds);
  return providerIds.flatMap((providerId) =>
    store.getModelsForProvider(providerId).map((model) => ({
      model_id: model.id,
      name: model.displayName ?? model.name,
      provider: model.providerId ?? providerId,
    })),
  );
}

export async function harnessModelOptions(
  harnessId: string,
): Promise<ModelEntry[]> {
  if (getProviderModelSelectionHint(harnessId) != null) {
    return [];
  }
  const store = useProviderModelCacheStore.getState();
  await store.refreshProviderModels(harnessId);
  return store.getModelsForProvider(harnessId).map((model) => ({
    model_id: model.id,
    name: model.displayName ?? model.name,
  }));
}

export { GOOSE_PROVIDER_ID };
