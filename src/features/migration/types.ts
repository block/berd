/**
 * Frontend mirror of the Tauri-side `DisabledExtension` struct. Field names
 * match the camelCase shape emitted by `src-tauri/src/commands/migration.rs`.
 */
export interface DisabledExtension {
  configKey: string;
  name: string;
}

/**
 * Frontend mirror of the Tauri-side `MigrationStatus` struct. Returned by the
 * `migration_status` command and written via `mark_migration_complete`.
 */
export interface LegacyRemovedExtension {
  configKey: string;
  name: string;
}

export interface MigrationStatus {
  done: boolean;
  completedAt?: string;
  disabledExtensions: DisabledExtension[];
  backupPath?: string;
  bannerDismissedAt?: string;
  legacyExtensionCleanupDone?: boolean;
  legacyExtensionCleanupCompletedAt?: string;
  legacyRemovedExtensions?: LegacyRemovedExtension[];
  legacyExtensionCleanupBackupPath?: string;
}

/**
 * Frontend mirror of the Tauri-side `BackupResult` struct, returned by the
 * `backup_goose_config` command.
 */
export interface BackupResult {
  backedUp: boolean;
  sourcePath: string;
  backupPath?: string;
}

export interface MarkMigrationCompleteRequest {
  disabledExtensions: DisabledExtension[];
  backupPath?: string;
}

export interface MarkLegacyExtensionCleanupCompleteRequest {
  removedExtensions: LegacyRemovedExtension[];
  backupPath?: string;
}

/**
 * Result of a successful `runMigration()` orchestration pass. Returned to the
 * caller so it can hand the payload to `mark_migration_complete`.
 */
export interface MigrationResult {
  disabledExtensions: DisabledExtension[];
  backupPath?: string;
}

export type MigrationGateStatus = "loading" | "running" | "ready" | "error";
