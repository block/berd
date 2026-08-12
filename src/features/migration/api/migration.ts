import { invoke } from "@tauri-apps/api/core";
import type {
  BackupResult,
  MarkLegacyExtensionCleanupCompleteRequest,
  MarkMigrationCompleteRequest,
  MigrationStatus,
} from "../types";

/**
 * Read the persisted migration marker from the Tauri app data dir. Missing
 * marker is reported as `{ done: false, disabledExtensions: [] }`.
 */
export async function getMigrationStatus(): Promise<MigrationStatus> {
  return invoke<MigrationStatus>("migration_status");
}

/**
 * Make a timestamped sibling copy of the user's goose `config.yaml`. If the
 * source is missing (fresh install), returns `{ backedUp: false, ... }` without
 * raising — the migration should still proceed.
 */
export async function backupGooseConfig(): Promise<BackupResult> {
  return invoke<BackupResult>("backup_goose_config");
}

/**
 * Persist the migration marker, recording which extensions were disabled and
 * (if any) the backup path produced by `backupGooseConfig`.
 */
export async function markMigrationComplete(
  request: MarkMigrationCompleteRequest,
): Promise<MigrationStatus> {
  return invoke<MigrationStatus>("mark_migration_complete", { request });
}

/**
 * Persist a `bannerDismissedAt` timestamp on the migration marker so the
 * post-migration disabled-extensions banner stays dismissed across launches.
 * Returns the updated status; no-op when the migration marker has not been
 * written yet.
 */
export async function dismissMigrationBanner(): Promise<MigrationStatus> {
  return invoke<MigrationStatus>("dismiss_migration_banner");
}

/**
 * Persist that the stale legacy bundled-extension cleanup has run, including
 * which extensions were removed and the cleanup-specific backup path, if any.
 */
export async function markLegacyExtensionCleanupComplete(
  request: MarkLegacyExtensionCleanupCompleteRequest,
): Promise<MigrationStatus> {
  return invoke<MigrationStatus>("mark_legacy_extension_cleanup_complete", {
    request,
  });
}
