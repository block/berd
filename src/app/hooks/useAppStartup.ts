import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useProviderInventoryStore } from "@/features/providers/stores/providerInventoryStore";
import {
  discoverAcpProvidersFromEntries,
  type AcpProvider,
} from "@/shared/api/acp";
import { setNotificationHandler, getClient } from "@/shared/api/acpConnection";
import notificationHandler from "@/shared/api/acpNotificationHandler";
import { perfLog } from "@/shared/lib/perfLog";
import {
  hasAllowedModelProvider,
  parseProviderAllowlist,
} from "@/features/providers/distroProviderConstraints";
import { getModelProviders } from "@/features/providers/providerCatalog";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useDistroStore } from "@/features/settings/stores/distroStore";
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
      const inventoryStore = useProviderInventoryStore.getState();
      const catalogStore = useProviderCatalogStore.getState();
      const distroStore = useDistroStore.getState();

      const applyProvidersFromInventory = (
        entries: Parameters<typeof discoverAcpProvidersFromEntries>[0],
        validated = false,
      ) => {
        const providers = discoverAcpProvidersFromEntries(entries);
        const providerAllowlist = parseProviderAllowlist(
          useDistroStore.getState().manifest,
        );
        store.setProviders(
          filterStartupProvidersForDistro(
            providers,
            providerAllowlist,
            getModelProviders(),
          ),
          validated,
        );
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

      const loadProviderCatalog = async () => {
        const t0 = performance.now();
        try {
          const entries = await catalogStore.load();
          const inventoryEntries = [
            ...useProviderInventoryStore.getState().entries.values(),
          ];
          if (inventoryEntries.length > 0) {
            applyProvidersFromInventory(inventoryEntries, true);
          }
          perfLog(
            `[perf:startup] loadProviderCatalog done in ${(performance.now() - t0).toFixed(1)}ms (n=${entries.length})`,
          );
        } catch (err) {
          console.error("Failed to load provider catalog on startup:", err);
        }
      };

      const loadProvidersAndInventory = async () => {
        const t0 = performance.now();
        store.setProvidersLoading(true);
        inventoryStore.setLoading(true);
        try {
          const { getProviderInventory, getSupportedRawModelProviderIds } =
            await import("@/features/providers/api/inventory");
          const rawSupportedModelsProviderIds =
            getSupportedRawModelProviderIds();
          const entries = await getProviderInventory(undefined, {
            rawSupportedModelsProviderIds,
          });

          // Populate inventory store
          inventoryStore.setEntries(entries);

          // Derive ACP providers from the same response
          const providers = applyProvidersFromInventory(entries, true);

          perfLog(
            `[perf:startup] loadProvidersAndInventory done in ${(performance.now() - t0).toFixed(1)}ms (entries=${entries.length}, providers=${providers.length})`,
          );
          return entries;
        } catch (err) {
          console.error(
            "Failed to load providers and inventory on startup:",
            err,
          );
          return [];
        } finally {
          store.setProvidersLoading(false);
          inventoryStore.setLoading(false);
        }
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

      // Catalog loading has its own fallback/error state. Inventory waits for it
      // so raw model hydration can stay inside the supported provider set.
      const providerCatalogLoad = loadProviderCatalog();

      await loadDistroBundle();

      const providersAndInventoryLoad = providerCatalogLoad.then(
        loadProvidersAndInventory,
      );

      await Promise.allSettled([
        loadPersonas(),
        providersAndInventoryLoad,
        loadSessionState(),
      ]);
      // Background refresh updates stale inventory after the first usable
      // provider list is available.
      void providersAndInventoryLoad.then(async (entries) => {
        try {
          const {
            backgroundRefreshInventory,
            getSupportedInventoryRefreshProviderIds,
            getSupportedRawModelProviderIds,
          } = await import("@/features/providers/api/inventory");
          await backgroundRefreshInventory(inventoryStore, {
            initialEntries: entries,
            rawSupportedModelsProviderIds: getSupportedRawModelProviderIds(),
            refreshProviderIds: getSupportedInventoryRefreshProviderIds(),
          });
        } catch (err) {
          console.error(
            "Failed to refresh provider inventory on startup:",
            err,
          );
        }
      });
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
