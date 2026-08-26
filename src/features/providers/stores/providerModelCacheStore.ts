import { create } from "zustand";
import { providerModelOptionsFromIds } from "../lib/modelRecommendations";
import type { ModelOption } from "@/features/chat/types";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { getClient } from "@/shared/api/acpConnection";
import { notifyProviderModelInventoryInvalidated } from "../lib/providerModelInventoryEvents";
import { filterDiscoveredModelIds } from "@/shared/runtime-config/modelProviderPolicy";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";

const MODEL_CACHE_STORAGE_KEY = "goose:providerModelCache:v2";
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const inFlightRefreshes = new Map<string, Promise<void>>();
const queuedForceRefreshes = new Map<string, Promise<void>>();
const providerRefreshVersions = new Map<string, number>();

export interface CachedProviderModels {
  providerId: string;
  models: ModelOption[];
  fetchedAt: number;
  runtimeManaged?: boolean;
  configuredModels?: ModelOption[];
  error?: string;
}

interface ProviderModelCacheState {
  providers: Map<string, CachedProviderModels>;
  refreshingProviderIds: Set<string>;
  runtimeManagedProviderIds: Set<string>;
}

interface ProviderModelCacheActions {
  loadPersisted: () => void;
  seedRuntimeModels: (
    modelsByProviderId: Map<string, ModelOption[]>,
    options?: { fresh?: boolean; runtimeManagedProviderIds?: Set<string> },
  ) => void;
  getModelsForProvider: (providerId: string) => ModelOption[];
  isModelInventoryAuthoritative: (providerId: string) => boolean;
  getError: (providerId: string) => string | null;
  refreshProviderModels: (
    providerId: string,
    options?: { force?: boolean },
  ) => Promise<void>;
  refreshAllModelProviders: (
    providerIds: string[],
    options?: { force?: boolean },
  ) => Promise<void>;
  invalidateProvider: (providerId: string) => void;
}

export type ProviderModelCacheStore = ProviderModelCacheState &
  ProviderModelCacheActions;

function readPersistedModels(): Map<string, CachedProviderModels> {
  if (typeof window === "undefined") {
    return new Map();
  }

  try {
    const raw = window.localStorage.getItem(MODEL_CACHE_STORAGE_KEY);
    if (!raw) {
      return new Map();
    }
    const parsed = JSON.parse(raw) as CachedProviderModels[];
    if (!Array.isArray(parsed)) {
      return new Map();
    }
    return new Map(
      parsed
        .filter((entry) => entry?.providerId && Array.isArray(entry.models))
        .map((entry) => [entry.providerId, entry]),
    );
  } catch {
    return new Map();
  }
}

function persistModels(providers: Map<string, CachedProviderModels>): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      MODEL_CACHE_STORAGE_KEY,
      JSON.stringify([...providers.values()]),
    );
  } catch {
    // localStorage may be unavailable.
  }
}

function runtimeManagedProviderIdsFrom(
  providers: Map<string, CachedProviderModels>,
): Set<string> {
  return new Set(
    [...providers.values()]
      .filter((entry) => entry.runtimeManaged)
      .map((entry) => entry.providerId),
  );
}

function readPersistedProviderState(): Pick<
  ProviderModelCacheState,
  "providers" | "runtimeManagedProviderIds"
> {
  const providers = readPersistedModels();
  return {
    providers,
    runtimeManagedProviderIds: runtimeManagedProviderIdsFrom(providers),
  };
}

async function fetchProviderSupportedModels(
  providerId: string,
): Promise<string[]> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableProvidersSupportedModelsList(
    {
      providerId,
    },
  );
  return response.models;
}

export function isCachedModelInventoryAuthoritative(
  entry: CachedProviderModels | undefined,
): boolean {
  return entry != null && (entry.runtimeManaged || entry.fetchedAt > 0);
}

function isStale(entry: CachedProviderModels | undefined): boolean {
  if (!entry || !isCachedModelInventoryAuthoritative(entry)) {
    return true;
  }
  return (
    !entry.runtimeManaged && Date.now() - entry.fetchedAt > MODEL_CACHE_TTL_MS
  );
}

function refreshVersion(providerId: string): number {
  return providerRefreshVersions.get(providerId) ?? 0;
}

function bumpRefreshVersion(providerId: string): void {
  providerRefreshVersions.set(providerId, refreshVersion(providerId) + 1);
  notifyProviderModelInventoryInvalidated(providerId);
}

export const useProviderModelCacheStore = create<ProviderModelCacheStore>(
  (set, get) => ({
    ...readPersistedProviderState(),
    refreshingProviderIds: new Set(),

    loadPersisted: () => {
      set(readPersistedProviderState());
    },

    seedRuntimeModels: (modelsByProviderId, options = {}) => {
      set((state) => {
        const providers = new Map(state.providers);
        const nextRuntimeManagedProviderIds = new Set(
          state.runtimeManagedProviderIds,
        );
        const runtimeProviderIds = new Set(modelsByProviderId.keys());
        const runtimeManagedProviderIds =
          options.runtimeManagedProviderIds ?? runtimeProviderIds;

        for (const providerId of runtimeProviderIds) {
          bumpRefreshVersion(providerId);
          const models = modelsByProviderId.get(providerId) ?? [];
          const runtimeManaged = runtimeManagedProviderIds.has(providerId);
          providers.set(providerId, {
            providerId,
            models,
            fetchedAt: runtimeManaged || options.fresh ? Date.now() : 0,
            ...(runtimeManaged
              ? { runtimeManaged }
              : { configuredModels: models }),
          });
          if (runtimeManaged) {
            nextRuntimeManagedProviderIds.add(providerId);
          } else {
            nextRuntimeManagedProviderIds.delete(providerId);
          }
        }

        for (const providerId of [...nextRuntimeManagedProviderIds]) {
          if (!runtimeProviderIds.has(providerId)) {
            bumpRefreshVersion(providerId);
            nextRuntimeManagedProviderIds.delete(providerId);
            providers.delete(providerId);
          }
        }

        persistModels(providers);
        return {
          providers,
          runtimeManagedProviderIds: nextRuntimeManagedProviderIds,
        };
      });
    },

    getModelsForProvider: (providerId) =>
      get().providers.get(providerId)?.models ?? [],

    isModelInventoryAuthoritative: (providerId) =>
      isCachedModelInventoryAuthoritative(get().providers.get(providerId)),

    getError: (providerId) => get().providers.get(providerId)?.error ?? null,

    refreshProviderModels: async (providerId, options = {}) => {
      const current = get();
      const existing = current.providers.get(providerId);
      if (
        existing?.runtimeManaged ||
        current.runtimeManagedProviderIds.has(providerId)
      ) {
        return;
      }
      if (!options.force && !isStale(existing)) {
        return;
      }

      if (options.force) {
        notifyProviderModelInventoryInvalidated(providerId);
      }

      const inFlightRefresh = inFlightRefreshes.get(providerId);
      if (inFlightRefresh) {
        if (!options.force) {
          await inFlightRefresh;
          return;
        }

        const queuedRefresh = queuedForceRefreshes.get(providerId);
        if (queuedRefresh) {
          await queuedRefresh;
          return;
        }

        const forceRefresh = inFlightRefresh
          .catch(() => undefined)
          .then(() => get().refreshProviderModels(providerId, { force: true }))
          .finally(() => {
            queuedForceRefreshes.delete(providerId);
          });
        queuedForceRefreshes.set(providerId, forceRefresh);
        await forceRefresh;
        return;
      }

      const versionAtStart = refreshVersion(providerId);
      const refresh = (async () => {
        set((state) => {
          const refreshingProviderIds = new Set(state.refreshingProviderIds);
          refreshingProviderIds.add(providerId);
          return { refreshingProviderIds };
        });

        try {
          const discoveredIds = await fetchProviderSupportedModels(providerId);
          const allowedIds = filterDiscoveredModelIds(
            useRuntimeConfigStore.getState().config,
            providerId,
            discoveredIds,
          );
          const discoveredModels = providerModelOptionsFromIds(
            providerId,
            allowedIds,
          );
          if (discoveredIds.length === 0) {
            if (
              !existing ||
              versionAtStart !== refreshVersion(providerId) ||
              (existing.fetchedAt === 0 && !existing.error)
            ) {
              return;
            }
            const retryableEntry = { ...existing, fetchedAt: 0 };
            delete retryableEntry.error;
            notifyProviderModelInventoryInvalidated(providerId);
            set((state) => {
              const providers = new Map(state.providers);
              providers.set(providerId, retryableEntry);
              persistModels(providers);
              return { providers };
            });
            return;
          }
          const configuredModels = existing?.configuredModels ?? [];
          const configuredModelsById = new Map(
            configuredModels.map((model) => [model.id, model]),
          );
          const hasConfiguredFeaturedModel = configuredModels.some(
            (model) => model.featured,
          );
          const discoveredModelIds = new Set(
            discoveredModels.map((model) => model.id),
          );
          const models = [
            ...discoveredModels.map((model) => ({
              ...model,
              ...(hasConfiguredFeaturedModel ? { featured: false } : {}),
              ...configuredModelsById.get(model.id),
            })),
            ...configuredModels.filter(
              (model) => !discoveredModelIds.has(model.id),
            ),
          ];
          const entry: CachedProviderModels = {
            providerId,
            models,
            fetchedAt: Date.now(),
            ...(configuredModels.length > 0 ? { configuredModels } : {}),
          };
          if (versionAtStart !== refreshVersion(providerId)) {
            return;
          }
          notifyProviderModelInventoryInvalidated(providerId);
          set((state) => {
            const providers = new Map(state.providers);
            providers.set(providerId, entry);
            persistModels(providers);
            return { providers };
          });
        } catch (error) {
          if (versionAtStart !== refreshVersion(providerId)) {
            return;
          }
          set((state) => {
            const providers = new Map(state.providers);
            providers.set(providerId, {
              providerId,
              models: existing?.models ?? [],
              fetchedAt: existing?.fetchedAt ?? 0,
              ...(existing?.configuredModels
                ? { configuredModels: existing.configuredModels }
                : {}),
              error: formatAcpErrorMessage(error),
            });
            persistModels(providers);
            return { providers };
          });
        } finally {
          set((state) => {
            const refreshingProviderIds = new Set(state.refreshingProviderIds);
            refreshingProviderIds.delete(providerId);
            return { refreshingProviderIds };
          });
        }
      })();

      inFlightRefreshes.set(providerId, refresh);
      try {
        await refresh;
      } finally {
        inFlightRefreshes.delete(providerId);
      }
    },

    refreshAllModelProviders: async (providerIds, options = {}) => {
      await Promise.allSettled(
        providerIds.map((providerId) =>
          get().refreshProviderModels(providerId, options),
        ),
      );
    },

    invalidateProvider: (providerId) => {
      bumpRefreshVersion(providerId);
      set((state) => {
        if (state.runtimeManagedProviderIds.has(providerId)) {
          const existing = state.providers.get(providerId);
          if (!existing || existing.runtimeManaged) {
            return {};
          }
          const providers = new Map(state.providers);
          providers.set(providerId, { ...existing, runtimeManaged: true });
          persistModels(providers);
          return { providers };
        }
        const providers = new Map(state.providers);
        providers.delete(providerId);
        persistModels(providers);
        return { providers };
      });
    },
  }),
);
