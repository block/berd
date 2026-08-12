import { expandHomePath } from "@/shared/lib/homePath";

/**
 * Canonical react-query keys for the `get_git_state` / `get_changed_files`
 * reads.
 *
 * Every observer and every invalidator must build its key here so a `~`-spelled
 * and an absolute spelling of the same directory land on one key. That keeps a
 * single backend call shared across observers and — the reason this helper
 * exists rather than each site expanding inline — lets the chat-settled
 * invalidation in `useGitStateAutoRefresh` target the exact key the
 * ContextPanel/sidebar observers subscribe to. Expanding in only some sites
 * silently drops the invalidation onto a key nothing observes.
 *
 * Expansion needs the (cached, one-time) home dir; pass `useHomeDir()`. Until it
 * resolves it is `null` and the raw spelling is used — the same fallback the
 * observers make, and home-relative reads stay disabled until then so no key is
 * fetched under a spelling that would immediately be replaced.
 */
export function normalizeGitPath(
  path: string | null | undefined,
  homeDir: string | null,
): string | null | undefined {
  return path && homeDir ? expandHomePath(path, homeDir) : path;
}

export function gitStateQueryKey(
  path: string | null | undefined,
  homeDir: string | null,
) {
  return ["git-state", normalizeGitPath(path, homeDir)] as const;
}

export function changedFilesQueryKey(
  path: string | null | undefined,
  homeDir: string | null,
) {
  return ["changed-files", normalizeGitPath(path, homeDir)] as const;
}
