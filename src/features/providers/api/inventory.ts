import type {
  ProviderInventoryEntryDto,
  ProviderInventoryModelDto,
  RefreshProviderInventoryResponseUnstable as RefreshProviderInventoryResponse,
} from "@aaif/goose-sdk";
import { getClient } from "@/shared/api/acpConnection";
import { perfLog } from "@/shared/lib/perfLog";
import { humanizeRawModelId } from "../lib/humanizeModelId";

export async function fetchProviderSupportedModels(
  providerId: string,
): Promise<string[]> {
  const client = await getClient();
  const t0 = performance.now();
  const response = await client.goose.GooseUnstableProvidersSupportedModelsList(
    { providerId },
  );
  perfLog(
    `[perf:inventory] fetchProviderSupportedModels done in ${(performance.now() - t0).toFixed(1)}ms providerId=${providerId} (n=${response.models.length})`,
  );
  return response.models;
}

async function mergeRawSupportedModels(
  entry: ProviderInventoryEntryDto,
): Promise<ProviderInventoryEntryDto> {
  if (!entry.configured) return entry;
  let rawIds: string[];
  try {
    rawIds = await fetchProviderSupportedModels(entry.providerId);
  } catch (err) {
    console.warn(
      `[inventory] fetchProviderSupportedModels failed for providerId=${entry.providerId}:`,
      err,
    );
    return entry;
  }
  const existingIds = new Set(entry.models.map((m) => m.id));
  const additions: ProviderInventoryModelDto[] = rawIds
    .filter((id) => !existingIds.has(id))
    .map((id) => ({ id, name: humanizeRawModelId(id), recommended: false }));
  if (additions.length === 0) return entry;
  return { ...entry, models: [...entry.models, ...additions] };
}

export async function getProviderInventory(
  providerIds: string[] = [],
): Promise<ProviderInventoryEntryDto[]> {
  const client = await getClient();
  const t0 = performance.now();
  const response = await client.goose.GooseUnstableProvidersList({
    providerIds,
  });
  perfLog(
    `[perf:inventory] getProviderInventory done in ${(performance.now() - t0).toFixed(1)}ms (n=${response.entries.length})`,
  );
  return Promise.all(response.entries.map(mergeRawSupportedModels));
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
  initialEntries?: ProviderInventoryEntryDto[],
): Promise<void> {
  const entries = initialEntries?.length
    ? initialEntries
    : await getProviderInventory();

  if (!initialEntries?.length) {
    inventoryStore.mergeEntries(entries);
  }

  const configuredProviderIds = entries
    .filter((entry) => entry.configured)
    .map((entry) => entry.providerId);
  if (configuredProviderIds.length === 0) return;

  const refresh = await refreshProviderInventory(configuredProviderIds);
  if (refresh.started.length === 0 && (refresh.skipped ?? []).length === 0) {
    return;
  }

  const { syncProviderInventory } = await import("./inventorySync");
  await syncProviderInventory(configuredProviderIds, {
    initialRefresh: refresh,
    onEntries: (entries) => inventoryStore.mergeEntries(entries),
  });
}
