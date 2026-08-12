import { backupGooseConfig } from "./api/migration";
import { isStaleLegacyBundledExtension } from "./lib/legacyBundledExtensions";
import type { LegacyRemovedExtension } from "./types";
import {
  listExtensions,
  removeExtension,
} from "@/features/extensions/api/extensions";
import { getDisplayName } from "@/features/extensions/types";

export interface LegacyBundledExtensionsCleanupResult {
  removedExtensions: LegacyRemovedExtension[];
  backupPath?: string;
}

/**
 * One-time cleanup for stale internal-era bundled MCPs. These entries were
 * seeded into older config files, are disabled, and are no longer shipped by
 * current Goose core. Removing them makes config.yaml mean "things the user or
 * app intentionally has" again, and keeps the Connections page from showing
 * inert inventory as if it were installed.
 */
export async function cleanupLegacyBundledExtensions({
  excludeConfigKeys = [],
}: {
  // On the first onboarding migration pass, extensions in this set were enabled
  // immediately before migration disabled them. Preserve those: an enabled
  // legacy extension is the closest signal we have that someone may use it.
  excludeConfigKeys?: string[];
} = {}): Promise<LegacyBundledExtensionsCleanupResult> {
  const excluded = new Set(excludeConfigKeys);
  const extensions = await listExtensions();
  const staleExtensions = extensions.filter(
    (extension) =>
      !excluded.has(extension.config_key) &&
      isStaleLegacyBundledExtension(extension),
  );

  if (staleExtensions.length === 0) {
    return { removedExtensions: [] };
  }

  // Back up only when there is something to mutate. This may create a second
  // backup for existing users whose onboarding migration already ran, which is
  // intentional: this cleanup is a separate mutation of config.yaml.
  const backup = await backupGooseConfig();
  const removedExtensions: LegacyRemovedExtension[] = [];

  for (const extension of staleExtensions) {
    await removeExtension(extension.config_key);
    removedExtensions.push({
      configKey: extension.config_key,
      name: getDisplayName(extension),
    });
  }

  return {
    removedExtensions,
    backupPath: backup.backupPath,
  };
}
