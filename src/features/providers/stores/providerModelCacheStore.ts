import { create } from "zustand";
import { providerModelOptionsFromIds } from "../lib/modelRecommendations";
import type { ModelOption } from "@/features/chat/types";
import { getClient } from "@/shared/api/acpConnection";

const MODEL_CACHE_STORAGE_KEY = "goose:providerModelCache:v1";
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const inFlightRefreshes = new Map<string, Promise<void>>();
const queuedForceRefreshes = new Map<string, Promise<void>>();
const providerRefreshVersions = new Map<string, number>();

export interface CachedProviderModels {
  providerId: string;
  models: ModelOption[];
  fetchedAt: number;
  error?: string;
}

interface ProviderModelCacheState {
  providers: Map<string, CachedProviderModels>;
  refreshingProviderIds: Set<string>;
}

interface ProviderModelCacheActions {
  loadPersisted: () => void;
  getModelsForProvider: (providerId: string) => ModelOption[];
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

function isStale(entry: CachedProviderModels | undefined): boolean {
  if (!entry) {
    return true;
  }
  return Date.now() - entry.fetchedAt > MODEL_CACHE_TTL_MS;
}

function refreshVersion(providerId: string): number {
  return providerRefreshVersions.get(providerId) ?? 0;
}

function bumpRefreshVersion(providerId: string): void {
  providerRefreshVersions.set(providerId, refreshVersion(providerId) + 1);
}

export const useProviderModelCacheStore = create<ProviderModelCacheStore>(
  (set, get) => ({
    providers: readPersistedModels(),
    refreshingProviderIds: new Set(),

    loadPersisted: () => {
      set({ providers: readPersistedModels() });
    },

    getModelsForProvider: (providerId) =>
      get().providers.get(providerId)?.models ?? [],

    getError: (providerId) => get().providers.get(providerId)?.error ?? null,

    refreshProviderModels: async (providerId, options = {}) => {
      const current = get();
      const existing = current.providers.get(providerId);
      if (!options.force && !isStale(existing)) {
        return;
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
          const ids = await fetchProviderSupportedModels(providerId);
          const entry: CachedProviderModels = {
            providerId,
            models: providerModelOptionsFromIds(providerId, ids),
            fetchedAt: Date.now(),
          };
          if (versionAtStart !== refreshVersion(providerId)) {
            return;
          }
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
              error: errorMessage(error),
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
        const providers = new Map(state.providers);
        providers.delete(providerId);
        persistModels(providers);
        return { providers };
      });
    },
  }),
);
