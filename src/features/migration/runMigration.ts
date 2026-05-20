import { useAgentStore } from "@/features/agents/stores/agentStore";
import { setStoredModelPreference } from "@/features/chat/lib/modelPreferences";
import {
  listExtensions,
  toggleExtension,
} from "@/features/extensions/api/extensions";
import { getDisplayName } from "@/features/extensions/types";
import { getClient } from "@/shared/api/acpConnection";
import { backupGooseConfig } from "./api/migration";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_NAME,
  DEFAULT_PROVIDER_ID,
  KEEP_ENABLED,
} from "./lib/constants";
import type { DisabledExtension, MigrationResult } from "./types";

/**
 * One-shot orchestrator that performs the silent first-boot migration.
 *
 * Order matters: the backup MUST happen before `GooseOnboardingImportApply`,
 * since the import mutates the same `config.yaml`. The marker file is
 * intentionally NOT written here — that's the caller's responsibility, so a
 * crash mid-sequence leaves the marker absent and the next boot re-runs
 * everything from scratch.
 *
 * Failures bubble up as thrown errors. Since Databricks is guaranteed to be
 * provisioned on this build, a hard failure is a real bug and should surface
 * to the user via the gate's error state rather than be fallback-papered.
 */
export async function runMigration(): Promise<MigrationResult> {
  // 1. Snapshot the existing goose config before anything mutates it.
  const backup = await backupGooseConfig();
  const backupPath = backup.backupPath;

  const client = await getClient();

  // 2. Discover everything goose can import from the user's machine.
  const scan = await client.goose.GooseOnboardingImportScan({ sources: [] });
  const candidateIds = scan.candidates.map((candidate) => candidate.id);

  // 3. Apply every candidate, enabling any imported extensions in the process.
  //    The "yes to everything" semantics are intentional — the plan replaces
  //    the multi-step opt-in flow with a silent migration.
  if (candidateIds.length > 0) {
    await client.goose.GooseOnboardingImportApply({
      candidateIds,
      enableImportedExtensions: true,
    });
  }

  // 4. Pre-select Databricks (and the configured model when known) as the
  //    goose default. Only include `modelId` when we have a real one;
  //    otherwise save the provider and let the user pick a model from
  //    the chat model picker on first run. Any failure propagates: the
  //    gate surfaces it as a retryable error, and the marker stays
  //    unwritten so the next boot starts fresh.
  await client.goose.GooseDefaultsSave({
    providerId: DEFAULT_PROVIDER_ID,
    ...(DEFAULT_MODEL_ID ? { modelId: DEFAULT_MODEL_ID } : {}),
  });

  // 5. Mirror the default into frontend stores so the chat UI picks it up
  //    immediately on first launch without a reload. Skip the model
  //    preference when we don't have a real model id — the picker will
  //    prompt the user.
  if (DEFAULT_MODEL_ID) {
    setStoredModelPreference("goose", {
      providerId: DEFAULT_PROVIDER_ID,
      modelId: DEFAULT_MODEL_ID,
      modelName: DEFAULT_MODEL_NAME,
    });
  }
  useAgentStore.getState().setSelectedProvider("goose");

  // 6. Disable every extension that isn't in the keep list. Collect the names
  //    so the Extensions settings page can show a banner naming what got
  //    turned off.
  const extensions = await listExtensions();
  const disabledExtensions: DisabledExtension[] = [];
  for (const extension of extensions) {
    if (KEEP_ENABLED.has(extension.config_key)) {
      continue;
    }
    if (!extension.enabled) {
      // Already off — nothing to disable, nothing to surface in the banner.
      continue;
    }
    await toggleExtension(extension.config_key, false);
    disabledExtensions.push({
      configKey: extension.config_key,
      name: getDisplayName(extension),
    });
  }

  return {
    disabledExtensions,
    backupPath,
  };
}
