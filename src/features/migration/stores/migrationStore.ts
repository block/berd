import { create } from "zustand";
import { dismissMigrationBanner } from "../api/migration";
import type { DisabledExtension, MigrationStatus } from "../types";

interface MigrationStoreState {
  /** True once `migration_status` has been read at least once. */
  initialized: boolean;
  /** Mirrors the Tauri marker: `true` after the migration has been persisted. */
  done: boolean;
  /** ISO timestamp from the marker, if any. */
  completedAt?: string;
  /** Names + config keys of extensions the migration turned off. */
  disabledExtensions: DisabledExtension[];
  /** Path to the timestamped config backup, if one was made. */
  backupPath?: string;
  /** True once stale internal-era bundled MCPs have been cleaned from config. */
  legacyExtensionCleanupDone?: boolean;
  /** Names + config keys of stale legacy bundled MCPs removed from config. */
  legacyRemovedExtensions?: DisabledExtension[];
  /** Path to the cleanup-specific timestamped config backup, if one was made. */
  legacyExtensionCleanupBackupPath?: string;
  /**
   * ISO timestamp recording when the user dismissed the post-migration banner.
   * Persisted on the Tauri marker so dismissal sticks across launches.
   */
  bannerDismissedAt?: string;
}

interface MigrationStoreActions {
  setStatus: (status: MigrationStatus) => void;
  dismissBanner: () => Promise<void>;
  reset: () => void;
}

export type MigrationStore = MigrationStoreState & MigrationStoreActions;

const INITIAL_STATE: MigrationStoreState = {
  initialized: false,
  done: false,
  disabledExtensions: [],
};

/**
 * Caches the migration marker on the frontend so the Extensions banner doesn't
 * have to re-invoke Tauri every time its page mounts. Populated by
 * `useMigrationGate` on first read and updated when the migration completes.
 */
export const useMigrationStore = create<MigrationStore>((set, get) => ({
  ...INITIAL_STATE,

  setStatus: (status) =>
    set({
      initialized: true,
      done: status.done,
      completedAt: status.completedAt,
      disabledExtensions: status.disabledExtensions ?? [],
      backupPath: status.backupPath,
      legacyExtensionCleanupDone: status.legacyExtensionCleanupDone,
      legacyRemovedExtensions: status.legacyRemovedExtensions,
      legacyExtensionCleanupBackupPath: status.legacyExtensionCleanupBackupPath,
      bannerDismissedAt: status.bannerDismissedAt,
    }),

  dismissBanner: async () => {
    if (get().bannerDismissedAt) {
      return;
    }
    // Optimistically stamp locally so the banner disappears immediately even
    // if the Tauri round-trip is slow. The server reply is authoritative and
    // updates the timestamp to whatever ended up on disk.
    const optimisticAt = new Date().toISOString();
    set({ bannerDismissedAt: optimisticAt });
    try {
      const updated = await dismissMigrationBanner();
      set({
        bannerDismissedAt: updated.bannerDismissedAt ?? optimisticAt,
      });
    } catch (error) {
      console.warn("[migration] dismiss_migration_banner failed", error);
    }
  },

  reset: () => set({ ...INITIAL_STATE }),
}));
