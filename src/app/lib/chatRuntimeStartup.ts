import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { getCuratedAgentProviders } from "@/features/providers/curatedProviders";
import {
  hasAllowedModelProvider,
  parseProviderAllowlist,
} from "@/features/providers/runtimeProviderConstraints";
import { getModelCacheRefreshProviderIds } from "@/features/providers/modelCacheRefresh";
import { getModelProviders } from "@/features/providers/providerCatalog";
import { useAgentSetupStore } from "@/features/providers/stores/agentSetupStore";
import { useModelSetupStore } from "@/features/providers/stores/modelSetupStore";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { useDistroStore } from "@/features/settings/stores/distroStore";
import type { AcpProvider } from "@/shared/api/acp";
import { getClient, setNotificationHandler } from "@/shared/api/acpConnection";
import notificationHandler from "@/features/chat/acp/acpNotificationHandler";
import { registerChatSessionConfigSnapshotHandlers } from "@/features/chat/acp/sessionConfigSnapshotAdapter";
import { perfLog } from "@/shared/lib/perfLog";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import type { ProviderCatalogEntry } from "@/shared/types/providers";

export function filterStartupProvidersForRuntimeConfig(
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
  const runtimeConfigStore = useRuntimeConfigStore.getState();

  modelCacheStore.loadPersisted();

  // Subscribe to backend-owned agent setup state and rehydrate it once, at the
  // app level, so a card mid-install (or its eventual result) is restored after
  // navigating away or fully reloading the window. Attaching this before any
  // card mounts is what makes reload survival work.
  void useAgentSetupStore
    .getState()
    .init()
    .catch((err) => {
      console.error("Failed to initialize agent setup state on startup:", err);
    });

  // Same for backend-owned model-provider native sign-in state, so a sign-in
  // mid-flight (or its eventual result) is restored after navigating away or
  // fully reloading the window.
  void useModelSetupStore
    .getState()
    .init()
    .catch((err) => {
      console.error("Failed to initialize model setup state on startup:", err);
    });

  const applyCuratedProviders = (validated = true) => {
    const providerAllowlist = parseProviderAllowlist(
      useRuntimeConfigStore.getState().config,
    );
    const providers = filterStartupProvidersForRuntimeConfig(
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

  const loadRuntimeConfig = async () => {
    const result = await runtimeConfigStore.refresh();
    if (result.status !== "ready") {
      console.warn("Runtime config unavailable; using app defaults:", result);
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
      getModelCacheRefreshProviderIds(useRuntimeConfigStore.getState().config),
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

  await loadRuntimeConfig();
  await loadDistroBundle();
  applyCuratedProviders(true);

  void refreshProviderModels().catch((err) => {
    console.error("Failed to refresh provider models on startup:", err);
  });

  await Promise.allSettled([loadPersonas(), loadSessionState()]);
}
