import {
  listExtensions,
  removeExtension,
  toggleExtension,
} from "@/features/extensions/api/extensions";
import { backupGooseConfig } from "@/features/migration/api/migration";
import type { ExtensionEntry } from "../types";
import { KEEP_ENABLED } from "./keepEnabled";

// This bundled stdio server expects an HTTP request for hosted authentication.
// Keep user-owned servers and configurations that supply their own token.
function isLegacySalesforceMcp(extension: ExtensionEntry): boolean {
  return (
    extension.type === "stdio" &&
    extension.bundled === true &&
    extension.cmd.split(/[\\/]/).at(-1) === "uvx" &&
    extension.args.length === 1 &&
    /^mcp[-_]salesforce[-_]sq(?:@\d+(?:\.\d+){1,2}(?:[a-zA-Z0-9.+-]*))?$/.test(
      extension.args[0],
    ) &&
    !Object.hasOwn(extension.envs ?? {}, "SALESFORCE_TOKEN") &&
    !extension.env_keys?.includes("SALESFORCE_TOKEN")
  );
}

/**
 * Reconcile extension policy on every boot, including already-migrated installs.
 * Core tools stay enabled. Retired bundled Salesforce MCPs are backed up and
 * removed so the extension manager cannot load them on demand.
 * Startup callers log failures and continue, allowing a retry on the next boot.
 */
export async function reconcileExtensions(): Promise<void> {
  const extensions = await listExtensions();
  for (const extension of extensions) {
    if (!KEEP_ENABLED.has(extension.config_key) || extension.enabled) continue;
    try {
      await toggleExtension(extension.config_key, true);
    } catch (error) {
      console.warn(
        `Failed to re-enable always-on extension '${extension.config_key}':`,
        error,
      );
    }
  }

  const retired = extensions.filter(isLegacySalesforceMcp);
  if (retired.length === 0) return;
  await backupGooseConfig();
  for (const extension of retired) {
    const current = (await listExtensions()).find(
      (entry) => entry.config_key === extension.config_key,
    );
    if (
      current &&
      isLegacySalesforceMcp(current) &&
      JSON.stringify(current) === JSON.stringify(extension)
    ) {
      await removeExtension(current.config_key);
    }
  }
}
