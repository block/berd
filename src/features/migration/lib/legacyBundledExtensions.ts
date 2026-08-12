import { isCompanyManagedExtension } from "@/features/connections/lib/managedExtensions";
import { isNativeCapabilityExtension } from "@/features/extensions/lib/nativeCapabilities";
import type { ExtensionEntry } from "@/features/extensions/types";

// Legacy Block-internal/third-party MCPs that were seeded into older internal
// Goose configs but are no longer shipped by current Goose core. They were
// dormant (`enabled: false`) inventory, not user-installed connections, and now
// make the Connections page look like the user has a set of tools they never
// chose.
const LEGACY_BUNDLED_EXTENSION_KEYS = new Set([
  "blockappkit",
  "blockcell",
  "cashp2p",
  "databricks",
  "excalidraw",
  "googleslides",
  "looker",
  "neighborhood",
  "neon",
  "notebook",
  "playpen",
  "qaiindexsearch",
  "regulator",
  "snowflake",
  "supabase",
  "testrail",
  "ventana",
]);

function toMatchKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isBundled(extension: ExtensionEntry): boolean {
  return "bundled" in extension && extension.bundled === true;
}

export function isStaleLegacyBundledExtension(
  extension: ExtensionEntry,
): boolean {
  if (!isBundled(extension)) return false;
  if (extension.enabled) return false;
  if (!LEGACY_BUNDLED_EXTENSION_KEYS.has(toMatchKey(extension.config_key))) {
    return false;
  }
  // Defense in depth: if one of these keys later becomes a managed connection
  // or a native capability, do not delete it via this legacy cleanup.
  if (isCompanyManagedExtension(extension)) return false;
  if (isNativeCapabilityExtension(extension)) return false;
  return true;
}
