import { create } from "zustand";
import {
  readDefaultProviderReadiness,
  type DefaultProviderReadiness,
} from "../defaultProviderReadiness";
import type { ShareInFlightOptions } from "@/shared/lib/shareInFlight";

interface DefaultProviderReadinessStore {
  readiness: DefaultProviderReadiness | null;
  /** Refreshes from the backend; pass `{ coalesce: true }` from a startup or
   *  mount window where joining an in-flight read is acceptable. */
  refresh: (
    options?: ShareInFlightOptions,
  ) => Promise<DefaultProviderReadiness>;
}

export const useDefaultProviderReadinessStore =
  create<DefaultProviderReadinessStore>((set) => ({
    readiness: null,

    refresh: async (options) => {
      const readiness = await readDefaultProviderReadiness(options);
      set({ readiness });
      return readiness;
    },
  }));
