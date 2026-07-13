import { create } from "zustand";
import {
  readDefaultProviderReadiness,
  type DefaultProviderReadiness,
} from "../defaultProviderReadiness";

interface DefaultProviderReadinessStore {
  readiness: DefaultProviderReadiness | null;
  refresh: () => Promise<DefaultProviderReadiness>;
}

export const useDefaultProviderReadinessStore =
  create<DefaultProviderReadinessStore>((set) => ({
    readiness: null,

    refresh: async () => {
      const readiness = await readDefaultProviderReadiness();
      set({ readiness });
      return readiness;
    },
  }));
