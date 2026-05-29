import type {
  ProviderInventoryEntryDto,
  ProviderInventoryModelDto,
  RefreshProviderInventoryResponseUnstable as RefreshProviderInventoryResponse,
} from "@aaif/goose-sdk";
import { useDistroStore } from "@/features/settings/stores/distroStore";
import { getClient } from "@/shared/api/acpConnection";
import { perfLog } from "@/shared/lib/perfLog";
import { filterModelProvidersForDistro } from "../distroProviderConstraints";
import { humanizeRawModelId } from "../lib/humanizeModelId";
import {
  getAgentProvidersFromEntries,
  getModelProvidersFromEntries,
} from "../providerCatalog";
import { useProviderCatalogStore } from "../stores/providerCatalogStore";

interface RawSupportedModelsCacheEntry {
  promise: Promise<string[] | null>;
  expiresAtMs: number;
}

export type RawSupportedModelsCache = Map<string, RawSupportedModelsCacheEntry>;

export const RAW_SUPPORTED_MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

const defaultRawSupportedModelsCache: RawSupportedModelsCache = new Map();

export interface GetProviderInventoryOptions {
  includeRawSupportedModels?: boolean;
  rawSupportedModelsCache?: RawSupportedModelsCache;
  rawSupportedModelsProviderIds?: ReadonlySet<string>;
}

interface BackgroundRefreshInventoryOptions {
  initialEntries?: ProviderInventoryEntryDto[];
  rawSupportedModelsCache?: RawSupportedModelsCache;
  rawSupportedModelsProviderIds?: ReadonlySet<string>;
  refreshProviderIds?: ReadonlySet<string> | null;
}

interface SupportedModelsClient {
  GooseUnstableProvidersSupportedModelsList(params: {
    providerId: string;
  }): Promise<{ models: string[] }>;
}

export async function fetchProviderSupportedModels(
  providerId: string,
): Promise<string[]> {
  const client = await getClient();
  const goose = client.goose as typeof client.goose & SupportedModelsClient;
  const t0 = performance.now();
  const response = await goose.GooseUnstableProvidersSupportedModelsList({
    providerId,
  });
  perfLog(
    `[perf:inventory] fetchProviderSupportedModels done in ${(performance.now() - t0).toFixed(1)}ms providerId=${providerId} (n=${response.models.length})`,
  );
  return response.models;
}

function fetchRawSupportedModelsCached(
  providerId: string,
  cache?: RawSupportedModelsCache,
): Promise<string[] | null> {
  const activeCache = cache ?? defaultRawSupportedModelsCache;
  const now = Date.now();
  const cached = activeCache.get(providerId);
  if (cached) {
    if (cached.expiresAtMs > now) return cached.promise;
    activeCache.delete(providerId);
  }

  const rawModels = fetchProviderSupportedModels(providerId).catch((err) => {
    console.warn(
      `[inventory] fetchProviderSupportedModels failed for providerId=${providerId}:`,
      err,
    );
    return null;
  });
  activeCache.set(providerId, {
    promise: rawModels,
    expiresAtMs: now + RAW_SUPPORTED_MODELS_CACHE_TTL_MS,
  });
  return rawModels;
}

export function clearRawSupportedModelsCache(
  providerIds?: Iterable<string>,
): void {
  if (!providerIds) {
    defaultRawSupportedModelsCache.clear();
    return;
  }

  for (const providerId of providerIds) {
    defaultRawSupportedModelsCache.delete(providerId);
  }
}

async function mergeRawSupportedModels(
  entry: ProviderInventoryEntryDto,
  cache?: RawSupportedModelsCache,
  allowedProviderIds?: ReadonlySet<string>,
): Promise<ProviderInventoryEntryDto> {
  if (!entry.configured) return entry;
  if (entry.category !== "model") return entry;
  if (allowedProviderIds && !allowedProviderIds.has(entry.providerId)) {
    return entry;
  }

  const rawIds = await fetchRawSupportedModelsCached(entry.providerId, cache);
  if (!rawIds) return entry;

  const existingIds = new Set(entry.models.map((m) => m.id));
  const additions: ProviderInventoryModelDto[] = rawIds
    .filter((id) => !existingIds.has(id))
    .map((id) => ({ id, name: humanizeRawModelId(id), recommended: false }));
  if (additions.length === 0) return entry;
  return { ...entry, models: [...entry.models, ...additions] };
}

export function getSupportedRawModelProviderIds(): Set<string> {
  const catalogStore = useProviderCatalogStore.getState();
  if (!catalogStore.loaded) return new Set();

  return new Set(
    filterModelProvidersForDistro(
      getModelProvidersFromEntries(catalogStore.entries),
      useDistroStore.getState().manifest,
    ).map((provider) => provider.id),
  );
}

export function getSupportedInventoryRefreshProviderIds(): ReadonlySet<string> | null {
  const catalogStore = useProviderCatalogStore.getState();
  if (!catalogStore.loaded) return null;

  const supportedModelProviderIds = getSupportedRawModelProviderIds();
  const supportedAgentProviderIds = getAgentProvidersFromEntries(
    catalogStore.entries,
  )
    .filter((provider) => provider.setupMethod !== "none")
    .map((provider) => provider.id);

  return new Set([...supportedAgentProviderIds, ...supportedModelProviderIds]);
}

export async function getProviderInventory(
  providerIds: string[] = [],
  {
    includeRawSupportedModels = true,
    rawSupportedModelsCache,
    rawSupportedModelsProviderIds,
  }: GetProviderInventoryOptions = {},
): Promise<ProviderInventoryEntryDto[]> {
  const client = await getClient();
  const t0 = performance.now();
  const response = await client.goose.GooseUnstableProvidersList({
    providerIds,
  });
  perfLog(
    `[perf:inventory] getProviderInventory done in ${(performance.now() - t0).toFixed(1)}ms (n=${response.entries.length})`,
  );
  if (!includeRawSupportedModels) return response.entries;
  return Promise.all(
    response.entries.map((entry) =>
      mergeRawSupportedModels(
        entry,
        rawSupportedModelsCache,
        rawSupportedModelsProviderIds,
      ),
    ),
  );
}

export async function refreshProviderInventory(
  providerIds: string[] = [],
): Promise<RefreshProviderInventoryResponse> {
  const client = await getClient();
  const t0 = performance.now();
  const response = await client.goose.GooseUnstableProvidersInventoryRefresh({
    providerIds,
  });
  perfLog(
    `[perf:inventory] refreshProviderInventory done in ${(performance.now() - t0).toFixed(1)}ms started=[${response.started.join(",")}]`,
  );
  return response;
}

/**
 * Refresh configured provider inventories in the background, polling until
 * all providers finish refreshing. If no entries are supplied, fetch and merge
 * the current inventory snapshot first so the UI sees fresh cached data even
 * when no refresh starts.
 *
 * Does NOT set the store's `loading` flag, so the UI keeps showing cached data
 * during the refresh.
 */
export async function backgroundRefreshInventory(
  inventoryStore: {
    mergeEntries: (entries: ProviderInventoryEntryDto[]) => void;
  },
  {
    initialEntries,
    rawSupportedModelsCache,
    rawSupportedModelsProviderIds = getSupportedRawModelProviderIds(),
    refreshProviderIds = getSupportedInventoryRefreshProviderIds(),
  }: BackgroundRefreshInventoryOptions = {},
): Promise<void> {
  const inventoryOptions: GetProviderInventoryOptions = {
    rawSupportedModelsProviderIds,
  };
  if (rawSupportedModelsCache) {
    inventoryOptions.rawSupportedModelsCache = rawSupportedModelsCache;
  }

  const entries = initialEntries?.length
    ? initialEntries
    : await getProviderInventory(undefined, inventoryOptions);

  if (!initialEntries?.length) {
    inventoryStore.mergeEntries(entries);
  }

  const configuredProviderIds = entries
    .filter((entry) => entry.configured)
    .filter(
      (entry) =>
        !refreshProviderIds || refreshProviderIds.has(entry.providerId),
    )
    .map((entry) => entry.providerId);
  if (configuredProviderIds.length === 0) return;

  const refresh = await refreshProviderInventory(configuredProviderIds);
  if (refresh.started.length === 0 && (refresh.skipped ?? []).length === 0) {
    return;
  }

  const { syncProviderInventory } = await import("./inventorySync");
  await syncProviderInventory(configuredProviderIds, {
    initialRefresh: refresh,
    ...inventoryOptions,
    onEntries: (entries) => inventoryStore.mergeEntries(entries),
  });
}
