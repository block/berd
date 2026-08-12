import {
  listExtensions,
  toggleExtension,
} from "@/features/extensions/api/extensions";
import { KEEP_ENABLED } from "./keepEnabled";

/**
 * Best-effort startup reconcile that ensures every extension in
 * `KEEP_ENABLED` is currently enabled. Runs once per app boot after the
 * migration gate marks itself ready.
 *
 * Why this is separate from the migration: migration is gated on a "done"
 * marker that only fires the first time. If we add a new extension to the
 * keep-enabled set later (e.g. `extensionmanager`), users who already
 * migrated have it persisted as disabled and would never recover without
 * this reconcile.
 *
 * Failures are swallowed — extension toggles should never block app
 * startup. The caller logs but otherwise carries on.
 */
export async function reconcileAlwaysOnExtensions(): Promise<void> {
  const extensions = await listExtensions();
  for (const extension of extensions) {
    if (!KEEP_ENABLED.has(extension.config_key)) {
      continue;
    }
    if (extension.enabled) {
      continue;
    }
    try {
      await toggleExtension(extension.config_key, true);
    } catch (error) {
      console.warn(
        `Failed to re-enable always-on extension '${extension.config_key}':`,
        error,
      );
    }
  }
}
