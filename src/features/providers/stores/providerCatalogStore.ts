import { create } from "zustand";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import { CURATED_PROVIDER_CATALOG } from "../curatedProviders";

export const GOOSE_PROVIDER_CATALOG_ENTRY = CURATED_PROVIDER_CATALOG[0];

export interface ProviderCatalogState {
  entries: ProviderCatalogEntry[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

interface ProviderCatalogActions {
  load: () => Promise<ProviderCatalogEntry[]>;
  setEntries: (entries: ProviderCatalogEntry[]) => void;
  mergeEntries: (entries: ProviderCatalogEntry[]) => void;
  removeEntries: (providerIds: string[]) => void;
  reset: () => void;
}

export type ProviderCatalogStore = ProviderCatalogState &
  ProviderCatalogActions;

function curatedState(): ProviderCatalogState {
  return {
    entries: CURATED_PROVIDER_CATALOG,
    loading: false,
    loaded: true,
    error: null,
  };
}

export const useProviderCatalogStore = create<ProviderCatalogStore>((set) => ({
  ...curatedState(),

  load: async () => CURATED_PROVIDER_CATALOG,

  setEntries: (entries) => {
    set({
      entries,
      loading: false,
      loaded: true,
      error: null,
    });
  },

  // Overlay `entries` onto the current catalog, replacing any existing entry
  // with the same id and keeping the rest. Used to merge goose-setup-catalog
  // providers (openai/anthropic) into the runtime-config-derived catalog
  // without clobbering it.
  mergeEntries: (entries) => {
    set((state) => {
      const incomingIds = new Set(entries.map((entry) => entry.id));
      const kept = state.entries.filter((entry) => !incomingIds.has(entry.id));
      return {
        entries: [...kept, ...entries],
        loading: false,
        loaded: true,
        error: null,
      };
    });
  },

  removeEntries: (providerIds) => {
    set((state) => {
      const ids = new Set(providerIds);
      return {
        entries: state.entries.filter((entry) => !ids.has(entry.id)),
        loading: false,
        loaded: true,
        error: null,
      };
    });
  },

  reset: () => set(curatedState()),
}));
