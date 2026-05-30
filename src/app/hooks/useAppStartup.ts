import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { AcpProvider } from "@/shared/api/acp";
import { setNotificationHandler, getClient } from "@/shared/api/acpConnection";
import notificationHandler from "@/shared/api/acpNotificationHandler";
import { perfLog } from "@/shared/lib/perfLog";
import {
  hasAllowedModelProvider,
  parseProviderAllowlist,
} from "@/features/providers/distroProviderConstraints";
import { getModelProviders } from "@/features/providers/providerCatalog";
import { useDistroStore } from "@/features/settings/stores/distroStore";
import { getCuratedAgentProviders } from "@/features/providers/curatedProviders";
import { getModelCacheRefreshProviderIds } from "@/features/providers/modelCacheRefresh";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import type { KgooseProbeReport } from "../lib/startupDiagnostics";

const STARTUP_PROBE_TIMEOUT_MS = 5_000;

async function runStartupConnectivityProbe(): Promise<KgooseProbeReport | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const probePromise = invoke<KgooseProbeReport>("probe_kgoose_connectivity");
    const timeout = new Promise<KgooseProbeReport>((resolve) => {
      timeoutId = setTimeout(() => {
        // A hung probe is itself evidence the network path is broken;
        // surface that as a likely WARP failure so the UI can suggest the
        // right next step instead of waiting forever.
        resolve({
          likelyWarpFailure: true,
          status: null,
          kind: "request",
          message: "kgoose probe timed out",
        });
      }, STARTUP_PROBE_TIMEOUT_MS);
    });
    return await Promise.race([probePromise, timeout]);
  } catch (probeError) {
    console.error("Failed to probe kgoose connectivity:", probeError);
    return null;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

export function filterStartupProvidersForDistro(
  providers: AcpProvider[],
  providerAllowlist: Set<string> | null,
  modelProviders: Pick<ProviderCatalogEntry, "id">[],
): AcpProvider[] {
  if (!providerAllowlist) {
    return providers;
  }

  const shouldKeepGoose = hasAllowedModelProvider(
    modelProviders,
    providerAllowlist,
  );

  return providers.filter(
    (provider) => provider.id !== "goose" || shouldKeepGoose,
  );
}

export function useAppStartup() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [probe, setProbe] = useState<KgooseProbeReport | null>(null);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is bumped by `retry()` to force a re-run
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const tStartup = performance.now();
      perfLog("[perf:startup] useAppStartup begin");
      setReady(false);
      setError(null);
      setProbe(null);

      const tConn = performance.now();
      setNotificationHandler(notificationHandler);
      await getClient();
      perfLog(
        `[perf:startup] ACP getClient ready in ${(performance.now() - tConn).toFixed(1)}ms`,
      );

      const store = useAgentStore.getState();
      const modelCacheStore = useProviderModelCacheStore.getState();
      const distroStore = useDistroStore.getState();

      modelCacheStore.loadPersisted();

      const applyCuratedProviders = (validated = true) => {
        const providerAllowlist = parseProviderAllowlist(
          useDistroStore.getState().manifest,
        );
        const providers = filterStartupProvidersForDistro(
          getCuratedAgentProviders(),
          providerAllowlist,
          getModelProviders(),
        );
        store.setProviders(providers, validated);
        return providers;
      };

      const loadDistroBundle = async () => {
        try {
          const { getDistroBundle } = await import("@/shared/api/distro");
          const manifest = await getDistroBundle();
          distroStore.setManifest(manifest);
        } catch (err) {
          console.error("Failed to load distro bundle on startup:", err);
          distroStore.setManifest({ present: false });
        }
      };

      const loadPersonas = async () => {
        const t0 = performance.now();
        store.setPersonasLoading(true);
        try {
          const { listPersonas } = await import("@/shared/api/agents");
          const personas = await listPersonas();
          store.setPersonas(personas);
          perfLog(
            `[perf:startup] loadPersonas done in ${(performance.now() - t0).toFixed(1)}ms (n=${personas.length})`,
          );
        } catch (err) {
          console.error("Failed to load personas on startup:", err);
        } finally {
          store.setPersonasLoading(false);
        }
      };

      const refreshProviderModels = async () => {
        await modelCacheStore.refreshAllModelProviders(
          getModelCacheRefreshProviderIds(useDistroStore.getState().manifest),
        );
      };

      const loadSessionState = async () => {
        const t0 = performance.now();
        perfLog("[perf:startup] loadSessionState start");
        const { loadSessions } = useChatSessionStore.getState();
        await loadSessions();
        perfLog(
          `[perf:startup] loadSessions done in ${(performance.now() - t0).toFixed(1)}ms`,
        );
      };

      applyCuratedProviders(false);

      await loadDistroBundle();
      applyCuratedProviders(true);

      void refreshProviderModels().catch((err) => {
        console.error("Failed to refresh provider models on startup:", err);
      });

      await Promise.allSettled([loadPersonas(), loadSessionState()]);
      perfLog(
        `[perf:startup] useAppStartup complete in ${(performance.now() - tStartup).toFixed(1)}ms`,
      );
    })()
      .catch(async (err) => {
        console.error("Failed to complete app startup:", err);
        const probeResult = await runStartupConnectivityProbe();
        if (!cancelled) {
          setProbe(probeResult);
          setError(err);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  return { ready, error, probe, retry };
}
