import { create } from "zustand";
import { providerModelOptionsFromIds } from "../lib/modelRecommendations";
import type { ModelOption } from "@/features/chat/types";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { getClient } from "@/shared/api/acpConnection";
import { notifyProviderModelInventoryInvalidated } from "../lib/providerModelInventoryEvents";

const MODEL_CACHE_STORAGE_KEY = "goose:providerModelCache:v1";
export const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const inFlightRefreshes = new Map<string, Promise<void>>();
const queuedForceRefreshes = new Map<string, Promise<void>>();
const providerRefreshVersions = new Map<string, number>();

export interface CachedProviderModels {
  providerId: string;
  /** Display candidates: live models plus configured recommendations. */
  models: ModelOption[];
  /** IDs returned by a successful live inventory response; the only proof. */
  provenModelIds?: string[];
  /** Monotonic provenance for comparing proof with a later ACP acknowledgement. */
  proofRevision?: number;
  fetchedAt: number;
  /** Runtime configuration policy; it does not establish model proof. */
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
  getProvenModelsForProvider: (providerId: string) => ModelOption[];
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

function mergeDisplayModels(
  discoveredModels: ModelOption[],
  configuredModels: ModelOption[],
): ModelOption[] {
  const configuredModelsById = new Map(
    configuredModels.map((model) => [model.id, model]),
  );
  const hasConfiguredFeaturedModel = configuredModels.some(
    (model) => model.featured,
  );
  const discoveredModelIds = new Set(discoveredModels.map((model) => model.id));
  return [
    ...discoveredModels.map((model) => ({
      ...model,
      ...(hasConfiguredFeaturedModel ? { featured: false } : {}),
      ...configuredModelsById.get(model.id),
    })),
    ...configuredModels.filter((model) => !discoveredModelIds.has(model.id)),
  ];
}

function getProvenModels(
  entry: CachedProviderModels | undefined,
): ModelOption[] {
  if (!isCachedModelInventoryAuthoritative(entry) || !entry?.provenModelIds) {
    return [];
  }
  const provenIds = new Set(entry.provenModelIds);
  return entry.models.filter((model) => provenIds.has(model.id));
}

export function isCachedModelInventoryAuthoritative(
  entry: CachedProviderModels | undefined,
): boolean {
  return (
    entry != null &&
    Array.isArray(entry.provenModelIds) &&
    entry.error === undefined &&
    Date.now() - entry.fetchedAt <= MODEL_CACHE_TTL_MS
  );
}

/**
 * Return whether cached inventory still permits a concrete provider/model pair.
 * Retained successful proof can disprove a selection even after it becomes
 * stale or a refresh fails. A later ACP acknowledgement supersedes that older
 * negative proof for the concrete prepared session only.
 */
export function isModelSelectionAllowedByCachedInventory(
  providerId: string,
  modelId: string,
  acknowledgedProofRevision = 0,
): boolean {
  const entry = useProviderModelCacheStore.getState().providers.get(providerId);
  if (!entry?.provenModelIds) return true;
  if (entry.provenModelIds.includes(modelId)) return true;
  // A proof can disprove only selections acknowledged before that proof. A
  // newer ACP acknowledgement is stronger evidence for that exact session.
  return proofRevision(entry) <= acknowledgedProofRevision;
}

function isStale(entry: CachedProviderModels | undefined): boolean {
  if (!entry || !isCachedModelInventoryAuthoritative(entry)) {
    return true;
  }
  return Date.now() - entry.fetchedAt > MODEL_CACHE_TTL_MS;
}

function proofRevision(entry: CachedProviderModels | undefined): number {
  return entry?.proofRevision ?? entry?.fetchedAt ?? 0;
}

function nextProofRevision(entry: CachedProviderModels | undefined): number {
  return Math.max(Date.now(), proofRevision(entry) + 1);
}

/** Provenance of the latest successful inventory observed for a provider. */
export function getModelInventoryProofRevision(providerId: string): number {
  return proofRevision(
    useProviderModelCacheStore.getState().providers.get(providerId),
  );
}

function refreshVersion(providerId: string): number {
  return providerRefreshVersions.get(providerId) ?? 0;
}

function bumpRefreshVersion(providerId: string): void {
  providerRefreshVersions.set(providerId, refreshVersion(providerId) + 1);
  notifyProviderModelInventoryInvalidated(providerId);
}

/** Publish successful live proof into the one shared inventory authority. */
export function publishProvenModelInventory(
  providerId: string,
  modelIds: readonly string[],
): void {
  const state = useProviderModelCacheStore.getState();
  const existing = state.providers.get(providerId);
  const discoveredModels = providerModelOptionsFromIds(providerId, [
    ...modelIds,
  ]);
  const configuredModels = existing?.configuredModels ?? [];
  // A successful preflight is newer proof than any refresh already in flight.
  // Supersede only the store's refresh writer; publishing proof is not an
  // invalidation and must not evict the preflight cache that produced it.
  providerRefreshVersions.set(providerId, refreshVersion(providerId) + 1);
  const providers = new Map(state.providers);
  providers.set(providerId, {
    providerId,
    models: mergeDisplayModels(discoveredModels, configuredModels),
    provenModelIds: [...modelIds],
    proofRevision: nextProofRevision(existing),
    fetchedAt: Date.now(),
    ...(existing?.runtimeManaged ? { runtimeManaged: true } : {}),
    ...(configuredModels.length > 0 ? { configuredModels } : {}),
  });
  useProviderModelCacheStore.setState({ providers });
  persistModels(providers);
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
          const configuredModels = modelsByProviderId.get(providerId) ?? [];
          const runtimeManaged = runtimeManagedProviderIds.has(providerId);
          const existing = providers.get(providerId);
          const provenModels = getProvenModels(existing);
          const provenModelIds = existing?.provenModelIds;
          const hasLiveProof = Array.isArray(provenModelIds);
          providers.set(providerId, {
            providerId,
            // Every runtime seed is advisory, including providers whose
            // connection policy is runtime-managed. A prior successful live
            // response stays proof, but the seed can neither create nor renew it.
            models: mergeDisplayModels(provenModels, configuredModels),
            fetchedAt: existing?.fetchedAt ?? 0,
            configuredModels,
            ...(hasLiveProof ? { provenModelIds } : {}),
            ...(existing?.proofRevision !== undefined
              ? { proofRevision: existing.proofRevision }
              : {}),
            ...(runtimeManaged ? { runtimeManaged } : {}),
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

    getProvenModelsForProvider: (providerId) => {
      const entry = get().providers.get(providerId);
      if (!entry?.provenModelIds) return [];
      const provenIds = new Set(entry.provenModelIds);
      return entry.models.filter((model) => provenIds.has(model.id));
    },

    isModelInventoryAuthoritative: (providerId) =>
      isCachedModelInventoryAuthoritative(get().providers.get(providerId)),

    getError: (providerId) => get().providers.get(providerId)?.error ?? null,

    refreshProviderModels: async (providerId, options = {}) => {
      const current = get();
      const existing = current.providers.get(providerId);
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
          const ids = await fetchProviderSupportedModels(providerId);
          const discoveredModels = providerModelOptionsFromIds(providerId, ids);
          const configuredModels = existing?.configuredModels ?? [];
          const models = mergeDisplayModels(discoveredModels, configuredModels);
          const entry: CachedProviderModels = {
            providerId,
            models,
            fetchedAt: Date.now(),
            provenModelIds: ids,
            proofRevision: nextProofRevision(existing),
            ...(existing?.runtimeManaged ? { runtimeManaged: true } : {}),
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
              ...(existing?.provenModelIds
                ? { provenModelIds: existing.provenModelIds }
                : isCachedModelInventoryAuthoritative(existing)
                  ? { provenModelIds: [] }
                  : {}),
              ...(existing?.proofRevision !== undefined
                ? { proofRevision: existing.proofRevision }
                : {}),
              ...(existing?.runtimeManaged ? { runtimeManaged: true } : {}),
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
        const existing = state.providers.get(providerId);
        if (state.runtimeManagedProviderIds.has(providerId) && existing) {
          const providers = new Map(state.providers);
          // Keep the configured display seed but remove proof: an invalidation
          // means the old live response can no longer justify compatibility.
          providers.set(providerId, {
            ...existing,
            models: existing.configuredModels ?? existing.models,
            fetchedAt: 0,
            provenModelIds: undefined,
          });
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
