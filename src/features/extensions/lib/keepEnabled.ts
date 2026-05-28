/**
 * Extensions to leave enabled after the first-boot migration runs. Every other
 * extension returned by `GooseConfigExtensions` is toggled off, and the
 * Extensions settings page flags any non-listed extension whose `enabled` is
 * `true` as "always on" so the user can reset it back to on-demand.
 *
 * These `config_key` values come from the goose backend's bundled extension
 * registry. If any of them are renamed upstream, this set must follow or the
 * migration will silently disable the wrong things. See
 * `crates/goose/src/agents/extension_manager.rs` in the goose repo for the
 * canonical list.
 */
export const KEEP_ENABLED: ReadonlySet<string> = new Set([
  "developer",
  "extensionmanager",
  "skills",
  "summon",
]);

export function isAlwaysOnAllowed(configKey: string): boolean {
  return KEEP_ENABLED.has(configKey);
}
