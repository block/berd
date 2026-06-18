import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { getCuratedAgentProviders } from "@/features/providers/curatedProviders";
import {
  hasAllowedModelProvider,
  parseProviderAllowlist,
} from "@/features/providers/distroProviderConstraints";
import { getModelCacheRefreshProviderIds } from "@/features/providers/modelCacheRefresh";
import { getModelProviders } from "@/features/providers/providerCatalog";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { useDistroStore } from "@/features/settings/stores/distroStore";
import type { AcpProvider } from "@/shared/api/acp";
import { getClient, setNotificationHandler } from "@/shared/api/acpConnection";
import notificationHandler from "@/features/chat/acp/acpNotificationHandler";
import { registerChatSessionConfigSnapshotHandlers } from "@/features/chat/acp/sessionConfigSnapshotAdapter";
import { perfLog } from "@/shared/lib/perfLog";
import type { ProviderCatalogEntry } from "@/shared/types/providers";

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

export async function runChatRuntimeStartup(): Promise<void> {
  const tConn = performance.now();
  registerChatSessionConfigSnapshotHandlers();
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
}
