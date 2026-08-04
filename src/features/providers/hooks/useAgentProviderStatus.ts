import { useCallback, useMemo } from "react";
import type { DoctorCheck, DoctorReport } from "@/shared/api/doctor";
import { useDoctorReport } from "@/shared/api/useDoctorReport";
import { crateCheckIdToProviderId } from "@/features/providers/lib/agentIdMap";
import { CURATED_PROVIDER_CATALOG_BY_ID } from "@/features/providers/curatedProviders";
import { useDefaultProviderReadinessStore } from "@/features/providers/stores/defaultProviderReadinessStore";
import { getBuildFeatureState } from "@/shared/profile/buildProfile";

export type AgentProviderReadiness = "ready" | "not_installed" | "not_ready";

interface UseAgentProviderStatusReturn {
  readyAgentIds: Set<string>;
  agentReadiness: Map<string, AgentProviderReadiness>;
  // The raw doctor check per provider id, so callers can surface install
  // source / version / update-available without re-probing.
  agentChecks: Map<string, DoctorCheck>;
  loading: boolean;
  refresh: () => Promise<Map<string, AgentProviderReadiness>>;
}

function gooseReadinessFromDefaultProviderStatus(
  defaultProviderStatus: string | undefined,
): AgentProviderReadiness {
  return getBuildFeatureState().byoKeyProviders &&
    defaultProviderStatus === "needs_setup"
    ? "not_ready"
    : "ready";
}

function currentGooseReadiness(): AgentProviderReadiness {
  return gooseReadinessFromDefaultProviderStatus(
    useDefaultProviderReadinessStore.getState().readiness?.status,
  );
}

function initialReadiness(
  gooseReadiness: AgentProviderReadiness = currentGooseReadiness(),
): Map<string, AgentProviderReadiness> {
  return new Map<string, AgentProviderReadiness>([["goose", gooseReadiness]]);
}

// Derive per-agent readiness from the doctor report. The crate identifies
// agents by `ai-agent-<name>`; map those back to the frontend's provider ids
// before recording readiness. Exported for non-hook consumers (berdctl)
// that share the agent picker's readiness semantics.
export function readinessFromReport(
  report: DoctorReport,
  options: { gooseReadiness?: AgentProviderReadiness } = {},
): Map<string, AgentProviderReadiness> {
  const readiness = initialReadiness(options.gooseReadiness);
  for (const check of report.checks) {
    const providerId = crateCheckIdToProviderId(check.id);
    if (!providerId) continue;

    // The in-app Goose provider is served by the bundled `goosed` sidecar and
    // does not depend on the system `goose` CLI. The `ai-agent-goose` doctor
    // check only probes that external CLI, so it must not gate readiness for
    // the served backend: leave the seeded value untouched. In BYO-key builds
    // that seed can still be "not_ready" when no default model provider has
    // been configured.
    if (providerId === "goose") continue;

    const provider = CURATED_PROVIDER_CATALOG_BY_ID.get(providerId);

    // A two-binary ACP agent (e.g. Amp) whose main CLI is present but whose
    // ACP bridge binary is missing: the doctor crate flags it status="warn"
    // with fixType="bridge", leaves bridge/bridgePath null, and keeps `path`
    // pointed at the main CLI. The bridge is what makes the agent usable over
    // ACP, so surface the bridge Install action instead of treating the agent
    // as installed/ready.
    if (check.fixType === "bridge") {
      readiness.set(providerId, "not_installed");
      continue;
    }

    // A bundled bridge vendors the full harness CLI, so it is the provider's
    // only binary and reports under `path`. Its bin dir is always on the
    // doctor PATH, so a healthy install resolves `path`; null means the
    // bundle itself is broken (packaging regression, wiped resources) and
    // sessions cannot spawn — treat that as not installed instead of masking
    // it as ready. Everything else accepts either binary of a two-binary
    // agent.
    const installed =
      (check.status === "pass" || check.status === "warn") &&
      (provider?.bundledBridge
        ? check.path != null
        : check.path != null || check.bridgePath != null);
    if (!installed) {
      readiness.set(providerId, "not_installed");
      continue;
    }

    // Three-case auth-readiness, gated on the curated catalog flags rather
    // than on authStatus alone. authStatus=null is overloaded (not-installed,
    // bridge-missing, genuine no-auth), so leaning on it would flip
    // supportsAuth-without-a-probe agents to "ready" pre-sign-in.
    if (provider?.supportsAuthStatus) {
      // Case 1: real CLI probe — trust the crate's authStatus.
      readiness.set(
        providerId,
        check.authStatus === "notAuthenticated" ? "not_ready" : "ready",
      );
      continue;
    }
    if (provider?.supportsAuth) {
      // Case 2: auth-capable but no real probe (e.g. copilot-acp) —
      // pessimistic default until the provider has an auth-status probe.
      readiness.set(providerId, "not_ready");
      continue;
    }
    // Case 3: no auth → ready once installed.
    readiness.set(providerId, "ready");
  }
  return readiness;
}

// Index the agent checks by frontend provider id, so cards can read their
// version/install-source readout from the same shared report.
function checksByProviderId(report: DoctorReport): Map<string, DoctorCheck> {
  const checks = new Map<string, DoctorCheck>();
  for (const check of report.checks) {
    const providerId = crateCheckIdToProviderId(check.id);
    if (providerId) checks.set(providerId, check);
  }
  return checks;
}

function readyIdsFromReadiness(
  readiness: Map<string, AgentProviderReadiness>,
): Set<string> {
  return new Set(
    [...readiness.entries()]
      .filter(([, status]) => status === "ready")
      .map(([id]) => id),
  );
}

export function useAgentProviderStatus(): UseAgentProviderStatusReturn {
  const query = useDoctorReport();
  const defaultProviderReadinessStatus = useDefaultProviderReadinessStore(
    (state) => state.readiness?.status,
  );
  const gooseReadiness = gooseReadinessFromDefaultProviderStatus(
    defaultProviderReadinessStatus,
  );

  const agentReadiness = useMemo(() => {
    if (!query.data) return initialReadiness(gooseReadiness);
    return readinessFromReport(query.data, { gooseReadiness });
  }, [gooseReadiness, query.data]);

  const readyAgentIds = useMemo(
    () => readyIdsFromReadiness(agentReadiness),
    [agentReadiness],
  );

  const agentChecks = useMemo(() => {
    if (!query.data) return new Map<string, DoctorCheck>();
    return checksByProviderId(query.data);
  }, [query.data]);

  const refetch = query.refetch;
  const refresh = useCallback(async () => {
    const result = await refetch();
    return result.data
      ? readinessFromReport(result.data, { gooseReadiness })
      : initialReadiness(gooseReadiness);
  }, [gooseReadiness, refetch]);

  return {
    readyAgentIds,
    agentReadiness,
    agentChecks,
    loading: query.isPending,
    refresh,
  };
}
