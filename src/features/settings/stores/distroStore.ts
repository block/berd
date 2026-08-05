import { create } from "zustand";
import { getDistroBundle } from "@/shared/api/distro";
import type { DistroBundleInfo } from "@/shared/types/distro";

interface DistroState {
  loaded: boolean;
  manifest: DistroBundleInfo;
  refresh: () => Promise<DistroBundleInfo>;
  setManifest: (manifest: DistroBundleInfo) => void;
}

const EMPTY_DISTRO: DistroBundleInfo = {
  present: false,
  kgooseConfigured: false,
};

export const useDistroStore = create<DistroState>((set) => {
  let refreshGeneration = 0;

  return {
    loaded: false,
    manifest: EMPTY_DISTRO,
    refresh: async () => {
      const generation = ++refreshGeneration;
      set((state) => ({
        manifest: { ...state.manifest, kgooseConfigured: false },
        loaded: true,
      }));
      try {
        const manifest = await getDistroBundle();
        if (generation === refreshGeneration) {
          set({ manifest, loaded: true });
        }
        return manifest;
      } catch (error) {
        if (generation === refreshGeneration) {
          set({ manifest: EMPTY_DISTRO, loaded: true });
        }
        throw error;
      }
    },
    setManifest: (manifest) => set({ manifest, loaded: true }),
  };
});
