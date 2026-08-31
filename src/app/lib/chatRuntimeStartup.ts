import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { loadPersistedMessageQueues } from "@/features/chat/stores/queuePersistence";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { getCuratedAgentProviders } from "@/features/providers/curatedProviders";
import {
  hasAllowedModelProvider,
  parseProviderAllowlist,
} from "@/features/providers/runtimeProviderConstraints";
import { getModelCacheRefreshProviderIds } from "@/features/providers/modelCacheRefresh";
import {
  getModelProviders,
  getProviderCatalog,
} from "@/features/providers/providerCatalog";
import { personaTargetMigration } from "@/features/agents/lib/personaExecutionTarget";
import {
  applyRuntimeProviderConfig,
  defaultModelInventoryModeForLoadResult,
} from "@/features/providers/runtimeProviderConfig";
import {
  listProviderSetupCatalog,
  selectSetupCatalogModelProviders,
  selectDatabricksHostConfigProvider,
} from "@/features/providers/api/catalog";
import { useAgentSetupStore } from "@/features/providers/stores/agentSetupStore";
import { useModelSetupStore } from "@/features/providers/stores/modelSetupStore";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import {
  getModelDiscoveryProviderIds,
  reconcileManagedDefaultProviderSelection,
  saveDefaultProviderSelectionFromConfiguredProvider,
} from "@/features/providers/defaultProviderConfig";
import { checkAllProviderStatus } from "@/features/providers/api/credentials";
import { useDefaultProviderReadinessStore } from "@/features/providers/stores/defaultProviderReadinessStore";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { REMOTE_SSH_SESSIONS_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { getExperiment } from "@/features/experiments/experimentPreferences";
import { useDistroStore } from "@/features/settings/stores/distroStore";
import type { AcpProvider } from "@/shared/api/acp";
import {
  getClient,
  setNotificationHandler,
  setPermissionHandler,
} from "@/shared/api/acpConnection";
import { handleSecurityPermissionRequest } from "@/features/security/acp/securityPermissionHandler";
import notificationHandler from "@/features/chat/acp/acpNotificationHandler";
import { registerChatSessionConfigSnapshotHandlers } from "@/features/chat/acp/sessionConfigSnapshotAdapter";
import { perfLog } from "@/shared/lib/perfLog";
import { getBuildFeatureState } from "@/shared/profile/buildProfile";
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

let startupLatch: Promise<void> | null = null;

/**
 * Startup must run once per window, or once per login where the auth gate is
 * on (see `resetChatRuntimeStartup`). Both callers can re-invoke while a run is
 * in flight (StrictMode re-mount in dev, the session-window bootstrap effect
 * re-firing on dep churn) or after it succeeded; all of them share the first
 * run. A failed run clears the latch so `useAppStartup`'s `retry()` starts a
 * genuine new attempt. Takes no options: the latch is first-call-wins, so
 * per-call options would be silently ignored on every call but the first —
 * `startChatRuntime`'s options stay private to keep that a compile error.
 */
export function runChatRuntimeStartup(): Promise<void> {
  if (!startupLatch) {
    const attempt = startChatRuntime();
    startupLatch = attempt;
    // Identity guard: a superseded attempt's late rejection must not null out
    // the latch its successor installed.
    attempt.catch(() => {
      if (startupLatch === attempt) {
        startupLatch = null;
      }
    });
  }
  return startupLatch;
}

/**
 * Drop the latch so the next `runChatRuntimeStartup()` runs startup again.
 *
 * Logout is the one place a window's identity changes without a reload: the
 * auth gate unmounts `AppShell` and remounts it on the next login, and the
 * latch would otherwise hand that remount the previous account's settled run.
 * Most of what startup loads is machine-local and identical across accounts,
 * but the runtime config and the provider allowlist it applies are org-scoped,
 * so a login to a different org would keep the old org's constraints until the
 * window reloaded.
 *
 * Deliberately partial: the ACP client and the zustand stores are module
 * singletons that survive the remount either way, so this restores the
 * pre-latch "startup runs per `AppShell` mount" behavior, not a full teardown.
 * An in-flight run is not cancelled — it keeps writing into those same stores,
 * and the next call starts a fresh run alongside it.
 */
export function resetChatRuntimeStartup(): void {
  startupLatch = null;
}

async function startChatRuntime(
  options: { hydrateMessageQueues?: boolean } = {},
): Promise<void> {
  const tConn = performance.now();
  registerChatSessionConfigSnapshotHandlers();
  setNotificationHandler(notificationHandler);
  if (options.hydrateMessageQueues !== false) {
    const persistedMessageQueues = await loadPersistedMessageQueues();
    useChatStore.getState().replaceQueuedMessages(persistedMessageQueues);
  }
  if (getBuildFeatureState().securityMl) {
    setPermissionHandler(handleSecurityPermissionRequest);
  }
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
      await distroStore.refresh();
    } catch (err) {
      console.error("Failed to load distro bundle on startup:", err);
    }
  };

  const loadRuntimeConfig = async () => {
    const result = await runtimeConfigStore.refresh();
    if (result.status !== "ready") {
      console.warn("Runtime config unavailable; using app defaults:", result);
    }

    const runtimeConfig = useRuntimeConfigStore.getState().config;
    await applyRuntimeProviderConfig(runtimeConfig, {
      defaultModelInventoryMode: defaultModelInventoryModeForLoadResult(result),
    });
  };

  // Merge goose's BYO setup catalog entries into the catalog. For openai,
  // anthropic, and google this provides API-key fields; for external
  // Databricks builds this provides the editable DATABRICKS_HOST field when
  // the runtime config injects no managed host. On by default; restricted
  // builds opt out with VITE_BYO_KEY_PROVIDERS=0.
  const loadSetupCatalog = async () => {
    if (!getBuildFeatureState().byoKeyProviders) {
      return;
    }
    const t0 = performance.now();
    try {
      const setupCatalog = await listProviderSetupCatalog();
      const databricks = selectDatabricksHostConfigProvider(setupCatalog);
      const providers = selectSetupCatalogModelProviders(setupCatalog).map(
        (provider) => (provider.id === databricks?.id ? databricks : provider),
      );
      if (providers.length > 0) {
        const runtimeConfigResult = useRuntimeConfigStore.getState().result;
        useProviderCatalogStore.getState().mergeEntries(providers);
        await applyRuntimeProviderConfig(
          useRuntimeConfigStore.getState().config,
          {
            defaultModelInventoryMode:
              defaultModelInventoryModeForLoadResult(runtimeConfigResult),
          },
        );
      }
      perfLog(
        `[perf:startup] loadSetupCatalog done in ${(performance.now() - t0).toFixed(1)}ms (n=${providers.length})`,
      );
    } catch (err) {
      console.warn(
        "Failed to load goose provider setup catalog on startup:",
        err,
      );
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

  const migratePersonaTargets = async (
    authoritativeProviderIds: ReadonlySet<string>,
  ) => {
    const { migratePersonaTargetIfUnchanged } = await import(
      "@/shared/api/agents"
    );
    const modelState = useProviderModelCacheStore.getState();
    const cachedModels = [...modelState.providers].flatMap(
      ([providerId, entry]) =>
        authoritativeProviderIds.has(providerId)
          ? entry.models.map((model) => ({
              ...model,
              providerId: model.providerId ?? providerId,
            }))
          : [],
    );
    const targetContext = {
      providers: useAgentStore.getState().providers,
      models: cachedModels,
      catalogEntries: getProviderCatalog(),
    };
    const personas = useAgentStore.getState().personas;
    await Promise.all(
      personas.map(async (persona) => {
        if (!persona.writable) return;
        const migration = personaTargetMigration(persona, targetContext);
        if (!migration) return;
        try {
          const migrated = await migratePersonaTargetIfUnchanged(
            persona,
            migration,
          );
          if (migrated) {
            // Do not replace the collection: a refresh or edit may have changed
            // another agent while this idempotent migration write was in flight.
            useAgentStore.getState().updatePersona(persona.id, migrated);
          }
        } catch (error) {
          console.warn("Failed to migrate custom agent target:", {
            personaId: persona.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  };

  const refreshProviderModels = async (): Promise<Set<string>> => {
    const runtimeConfigResult = useRuntimeConfigStore.getState().result;
    const configuredProviderIds = await getModelDiscoveryProviderIds(
      await checkAllProviderStatus({ coalesce: true }),
    );
    const refreshProviderIds = getModelCacheRefreshProviderIds(
      useRuntimeConfigStore.getState().config,
      {
        defaultModelInventoryMode:
          defaultModelInventoryModeForLoadResult(runtimeConfigResult),
        configuredProviderIds,
      },
    );
    await modelCacheStore.refreshAllModelProviders(refreshProviderIds);
    const modelState = useProviderModelCacheStore.getState();
    return new Set([
      ...modelState.runtimeManagedProviderIds,
      ...refreshProviderIds.filter((providerId) => {
        const entry = modelState.providers.get(providerId);
        return (
          !entry?.error && modelState.isModelInventoryAuthoritative(providerId)
        );
      }),
    ]);
  };

  const loadSessionState = async () => {
    const t0 = performance.now();
    perfLog("[perf:startup] loadSessionState start");
    const { loadSessions } = useChatSessionStore.getState();
    await loadSessions();
    perfLog(
      `[perf:startup] loadSessions done in ${(performance.now() - t0).toFixed(1)}ms`,
    );
    // After the local page load so mergeAcpSessionPage cannot race the
    // placeholder insert; the merge itself is additive for remoteHost either
    // way. The per-window experiment reconciliation hook also waits on this
    // startup latch before applying later runtime changes.
    if (getExperiment(REMOTE_SSH_SESSIONS_EXPERIMENT_ID)?.enabled) {
      try {
        const { rehydrateRemoteSessions } = await import(
          "@/features/chat/stores/remoteSessionPersistence"
        );
        await rehydrateRemoteSessions();
      } catch (err) {
        console.error("Failed to rehydrate remote sessions on startup:", err);
      }
    }
  };

  applyCuratedProviders(false);

  await loadRuntimeConfig();
  await loadSetupCatalog();
  try {
    await reconcileManagedDefaultProviderSelection();
  } catch (error) {
    console.warn("Failed to reconcile managed Goose provider defaults:", error);
  }
  // Reads plainly (no `coalesce`): the reconcile above can have just written
  // the Goose defaults this gate reads, so joining a read that started before
  // that write would report pre-reconcile defaults and can trip the
  // `needs_setup` recovery below into persisting a different default. The
  // composer pill and model picker coalesce on the same slot from mount, so
  // there is a real in-flight read to avoid here.
  const readiness = await useDefaultProviderReadinessStore.getState().refresh();
  if (
    readiness.status === "needs_setup" &&
    getBuildFeatureState().byoKeyProviders
  ) {
    // Recovery: a BYO key provider is configured but backend defaults are
    // missing (e.g. defaults lost while credentials survived). Persist it as
    // the default so the readiness gate clears; no-op when nothing is
    // configured.
    try {
      await saveDefaultProviderSelectionFromConfiguredProvider();
    } catch (error) {
      console.warn(
        "Failed to save default provider from configured provider:",
        error,
      );
    }
  }
  await loadDistroBundle();
  applyCuratedProviders(true);

  // Legacy agent-target repair runs off the critical path: the read-time
  // compatibility layer in personaExecutionTarget keeps unmigrated agents
  // working immediately, so startup never waits on inventory for migration.
  const providerModelsReady = refreshProviderModels().catch((err) => {
    console.error("Failed to refresh provider models on startup:", err);
    return new Set<string>();
  });

  await Promise.allSettled([loadPersonas(), loadSessionState()]);
  void providerModelsReady.then((authoritativeProviderIds) =>
    migratePersonaTargets(authoritativeProviderIds).catch((err) => {
      console.error("Failed to migrate custom agent targets:", err);
    }),
  );
}
