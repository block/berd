import { useAgentStore } from "@/features/agents/stores/agentStore";
import {
  getStoredModelPreference,
  setStoredModelPreference,
} from "@/features/chat/lib/modelPreferences";
import {
  listExtensions,
  toggleExtension,
} from "@/features/extensions/api/extensions";
import { getDisplayName } from "@/features/extensions/types";
import { getClient } from "@/shared/api/acpConnection";
import { backupGooseConfig } from "./api/migration";
import {
  getDefaultGooseModelId,
  getDefaultGooseModelName,
  getDefaultGooseModelProviderId,
} from "@/features/runtime-config/defaults";
import { KEEP_ENABLED } from "./lib/constants";
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
 * Failures from migration/import work bubble up as thrown errors. Saving the
 * default model is best effort because provider auth/connectivity should not
 * decide whether the app shell can start.
 */
export async function runMigration(): Promise<MigrationResult> {
  // 1. Snapshot the existing goose config before anything mutates it.
  const backup = await backupGooseConfig();
  const backupPath = backup.backupPath;

  const client = await getClient();

  // 2. Discover everything goose can import from the user's machine.
  const scan = await client.goose.GooseUnstableOnboardingImportScan({
    sources: [],
  });
  const candidateIds = scan.candidates.map((candidate) => candidate.id);

  // 3. Apply every candidate, enabling any imported extensions in the process.
  //    The "yes to everything" semantics are intentional — the plan replaces
  //    the multi-step opt-in flow with a silent migration.
  if (candidateIds.length > 0) {
    await client.goose.GooseUnstableOnboardingImportApply({
      candidateIds,
      enableImportedExtensions: true,
    });
  }

  const defaultProviderId = getDefaultGooseModelProviderId();
  const defaultModelId = getDefaultGooseModelId();
  const defaultModelName = defaultModelId
    ? getDefaultGooseModelName(defaultModelId)
    : undefined;

  // 4. Seed the local chat preference before touching backend defaults so the
  //    frontend can prefer the runtime model even when provider auth or
  //    connectivity prevents saving the backend default.
  if (
    defaultProviderId &&
    defaultModelId &&
    !getStoredModelPreference("goose")
  ) {
    setStoredModelPreference("goose", {
      providerId: defaultProviderId,
      modelId: defaultModelId,
      modelName: defaultModelName ?? defaultModelId,
    });
  }

  // 5. Pre-select the runtime-configured Goose provider (and model when known)
  //    as the goose default. Only include `modelId` when we have a real one;
  //    otherwise save the provider and let the user pick a model from
  //    the chat model picker on first run. Failures are logged and do not
  //    block the rest of migration.
  if (defaultProviderId) {
    try {
      await client.goose.GooseUnstableDefaultsSave({
        providerId: defaultProviderId,
        ...(defaultModelId ? { modelId: defaultModelId } : {}),
      });
    } catch (error) {
      console.error("Failed to save migrated default model:", error);
    }
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
