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

  reset: () => set(curatedState()),
}));
