import { isSetupCatalogModelProvider } from "@/features/providers/api/catalog";
import { syncRuntimeCustomProviders } from "@/features/providers/api/customProviders";
import type { ModelOption } from "@/features/chat/types";
import { CURATED_PROVIDER_CATALOG } from "@/features/providers/curatedProviders";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { getBuildFeatureState } from "@/shared/profile/buildProfile";
import type {
  RuntimeConfig,
  RuntimeConfigLoadResult,
  RuntimeGooseModel,
  RuntimeGooseModelProvider,
  RuntimeModelInventoryMode,
} from "@/shared/runtime-config/schema";
import type { ProviderCatalogEntry } from "@/shared/types/providers";

const GOOSE_AGENT_PROVIDER_ID = "goose";
const DATABRICKS_PROVIDER_ID = "databricks_v2";
const DATABRICKS_HOST_FIELD_KEY = "DATABRICKS_HOST";
const DEFAULT_MODEL_INVENTORY_MODE: RuntimeModelInventoryMode = "authoritative";

export function defaultModelInventoryModeForLoadResult(
  result: RuntimeConfigLoadResult,
): RuntimeModelInventoryMode {
  // `bundledFile` is treated like `appDefault`: the bundled runtime-config.json
  // fully replaces the compiled-in default in no-endpoint builds and carries the
  // same minimal seed provider, so its model inventory is a starting point to be
  // refreshed from the backend — not an authoritative endpoint-supplied list.
  // Only a live/cached admin endpoint response is authoritative.
  return result.status !== "ready" ||
    result.source === "appDefault" ||
    result.source === "bundledFile"
    ? "refreshable"
    : "authoritative";
}

function runtimeProviderToCatalogEntry(
  provider: RuntimeGooseModelProvider,
): ProviderCatalogEntry {
  return {
    id: provider.id,
    displayName: provider.displayName,
    category: "model",
    description: provider.description ?? provider.displayName,
    setupMethod: provider.setupMethod ?? "none",
    group: provider.group ?? "default",
    aliases: provider.aliases,
    nativeConnectQuery: provider.nativeConnectQuery,
    supportsInstall: false,
    supportsAuth: false,
    supportsAuthStatus: false,
    catalogSource: "runtime",
  };
}

export function providerCatalogFromRuntimeConfig(
  runtimeConfig: RuntimeConfig,
): ProviderCatalogEntry[] {
  const nonGooseModelProviders = CURATED_PROVIDER_CATALOG.filter(
    (provider) =>
      provider.category !== "model" || provider.id === GOOSE_AGENT_PROVIDER_ID,
  );
  const runtimeModelProviders = runtimeConfig.goose.modelProviders.map(
    runtimeProviderToCatalogEntry,
  );

  return [...nonGooseModelProviders, ...runtimeModelProviders];
}

export function mergeRuntimeProviderCatalog(
  existingEntries: ProviderCatalogEntry[],
  runtimeConfig: RuntimeConfig,
): ProviderCatalogEntry[] {
  const runtimeCatalog = providerCatalogFromRuntimeConfig(runtimeConfig);
  const runtimeIds = new Set(runtimeCatalog.map((entry) => entry.id));

  const preserved = existingEntries.filter(
    (entry) =>
      (isSetupCatalogModelProvider(entry) || entry.customProvider === true) &&
      !runtimeIds.has(entry.id),
  );
  const setupEntriesById = new Map(
    existingEntries
      .filter(isSetupCatalogModelProvider)
      .map((entry) => [entry.id, entry]),
  );
  for (const runtimeEntry of runtimeCatalog) {
    const setupEntry = setupEntriesById.get(runtimeEntry.id);
    if (!setupEntry) continue;
    runtimeEntry.setupCatalogProvider = true;
    runtimeEntry.setupMethod = setupEntry.setupMethod;
    runtimeEntry.fields = setupEntry.fields;
    runtimeEntry.docsUrl = setupEntry.docsUrl;
    runtimeEntry.nativeConnectQuery ??= setupEntry.nativeConnectQuery;
    runtimeEntry.aliases ??= setupEntry.aliases;
  }

  const databricks = runtimeConfig.goose.modelProviders.find(
    (provider) => provider.id === DATABRICKS_PROVIDER_ID,
  );
  const databricksSetupEntry = existingEntries.find(
    (entry) => entry.id === DATABRICKS_PROVIDER_ID,
  );
  if (databricks && databricksSetupEntry?.fields) {
    const databricksCatalogEntry = runtimeCatalog.find(
      (entry) => entry.id === DATABRICKS_PROVIDER_ID,
    );
    if (databricksCatalogEntry) {
      databricksCatalogEntry.fields = databricks.endpointEnv
        ? undefined
        : databricksSetupEntry.fields.filter(
            (field) => field.key === DATABRICKS_HOST_FIELD_KEY,
          );
    }
  }

  return [...runtimeCatalog, ...preserved];
}

function runtimeModelToOption(
  provider: RuntimeGooseModelProvider,
  model: RuntimeGooseModel,
  options: { sortOrder: number },
): ModelOption {
  return {
    id: model.id,
    name: model.name,
    displayName: model.name,
    providerId: provider.id,
    providerName: provider.displayName,
    contextLimit: model.contextLimit,
    recommended: model.recommended ?? false,
    featured: model.featured ?? false,
    sortOrder: options.sortOrder,
  };
}

export function runtimeModelInventory(
  runtimeConfig: RuntimeConfig,
): Map<string, ModelOption[]> {
  return new Map(
    runtimeConfig.goose.modelProviders.map((provider) => [
      provider.id,
      provider.models.map((model, sortOrder) =>
        runtimeModelToOption(provider, model, { sortOrder }),
      ),
    ]),
  );
}

export function runtimeGooseModelProviderIds(
  runtimeConfig: RuntimeConfig | null | undefined,
): string[] {
  return (
    runtimeConfig?.goose.modelProviders.map((provider) => provider.id) ?? []
  );
}

function modelInventoryMode(
  provider: RuntimeGooseModelProvider,
  defaultMode: RuntimeModelInventoryMode,
): RuntimeModelInventoryMode {
  return provider.modelInventoryMode ?? defaultMode;
}

export function runtimeManagedModelProviderIds(
  runtimeConfig: RuntimeConfig,
  defaultMode: RuntimeModelInventoryMode = DEFAULT_MODEL_INVENTORY_MODE,
): Set<string> {
  return new Set(
    runtimeConfig.goose.modelProviders
      .filter(
        (provider) =>
          modelInventoryMode(provider, defaultMode) === "authoritative",
      )
      .map((provider) => provider.id),
  );
}

export function runtimeRefreshableModelProviderIds(
  runtimeConfig: RuntimeConfig | null | undefined,
  defaultMode: RuntimeModelInventoryMode = DEFAULT_MODEL_INVENTORY_MODE,
): string[] {
  return (
    runtimeConfig?.goose.modelProviders
      .filter(
        (provider) =>
          modelInventoryMode(provider, defaultMode) === "refreshable",
      )
      .map((provider) => provider.id) ?? []
  );
}

let providerApplyGeneration = 0;
let providerApplyTail: Promise<void> = Promise.resolve();
let providerBackendSyncFailure:
  | { generation: number; error: unknown }
  | undefined;

export function applyRuntimeProviderConfig(
  runtimeConfig: RuntimeConfig,
  options: {
    seedModelsFresh?: boolean;
    defaultModelInventoryMode?: RuntimeModelInventoryMode;
    byoKeyProvidersEnabled?: boolean;
    /** Creation must fail rather than use a backend whose config did not apply. */
    requireBackendSync?: boolean;
    isCurrent?: () => boolean;
  } = {},
): Promise<void> {
  const generation = ++providerApplyGeneration;
  const isCurrent = () =>
    generation === providerApplyGeneration && options.isCurrent?.() !== false;
  const pending = providerApplyTail
    .catch(() => {})
    .then(async () => {
      if (!isCurrent()) return;
      try {
        await syncRuntimeCustomProviders(runtimeConfig, { isCurrent });
        if (isCurrent()) providerBackendSyncFailure = undefined;
      } catch (error) {
        if (!isCurrent()) return;
        providerBackendSyncFailure = { generation, error };
        if (options.requireBackendSync) throw error;
        console.warn("Failed to sync runtime custom providers:", error);
      }
      if (!isCurrent()) return;
      const byoKeyProvidersEnabled =
        options.byoKeyProvidersEnabled ??
        getBuildFeatureState().byoKeyProviders;
      const catalogStore = useProviderCatalogStore.getState();
      // With bring-your-own-key off, the runtime config is the sole catalog source
      // and wholesale-replaces the store (the pre-feature behavior). With it on,
      // merge so the fields-bearing openai/anthropic setup-catalog entries survive
      // every (re-)apply; the runtime config still wins for everything it defines.
      catalogStore.setEntries(
        byoKeyProvidersEnabled
          ? mergeRuntimeProviderCatalog(catalogStore.entries, runtimeConfig)
          : providerCatalogFromRuntimeConfig(runtimeConfig),
      );
      useProviderModelCacheStore
        .getState()
        .seedRuntimeModels(runtimeModelInventory(runtimeConfig), {
          fresh: options.seedModelsFresh,
          runtimeManagedProviderIds: runtimeManagedModelProviderIds(
            runtimeConfig,
            options.defaultModelInventoryMode,
          ),
        });
    });
  providerApplyTail = pending;
  return (async () => {
    try {
      await pending;
    } catch (error) {
      if (generation === providerApplyGeneration) throw error;
    }
    // Startup/settings may supersede this request while ACP is in flight.
    // Every waiting creator must wait for the newest queued reconciliation.
    while (generation !== providerApplyGeneration) {
      const latest = providerApplyTail;
      await latest;
      if (latest === providerApplyTail) break;
    }
    if (
      options.requireBackendSync &&
      providerBackendSyncFailure?.generation === providerApplyGeneration
    ) {
      throw providerBackendSyncFailure.error;
    }
  })();
}
