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
import { backupGooseConfig, prepareOnboardingImport } from "./api/migration";
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
 * Order matters: the backup MUST happen before applying the native import plan,
 * since the plan mutates the same Goose config through ACP. The marker file is
 * intentionally NOT written here — that's the caller's responsibility. Every
 * mutation is idempotent, so a crash leaves the marker absent and the next boot
 * can retry safely.
 *
 * Failures from migration/import work bubble up as thrown errors. Saving the
 * default model is best effort because provider auth/connectivity should not
 * decide whether the app shell can start.
 */
export async function runMigration(): Promise<MigrationResult> {
  // 1. Snapshot the existing goose config before anything mutates it.
  const backup = await backupGooseConfig();
  const backupPath = backup.backupPath;

  // 2. Tauri discovers only fixed platform locations, parses bounded files,
  //    applies secrets and extensions through a native Goose connection, and
  //    copies legacy skills to the canonical personal-skills directory.
  //    Sensitive config values never cross into the renderer.
  const importPlan = await prepareOnboardingImport();
  if (importPlan.warnings.length > 0) {
    console.warn("Some onboarding imports were skipped:", importPlan.warnings);
  }

  const client = await getClient();

  // 3. Goose remains authoritative for its provider and config state.
  //    Imported provider defaults are best effort because the distro default
  //    below intentionally supersedes them when configured.
  if (importPlan.providerDefaults) {
    try {
      await client.goose.GooseUnstableDefaultsSave({
        providerId: importPlan.providerDefaults.providerId,
        ...(importPlan.providerDefaults.modelId
          ? { modelId: importPlan.providerDefaults.modelId }
          : {}),
      });
    } catch (error) {
      console.warn("Failed to apply imported provider default:", error);
    }
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
