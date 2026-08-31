/**
 * Per-host goose binary overrides for remote SSH backends.
 *
 * The remote bootstrap normally resolves a bare `goose` from the ssh login
 * PATH. This override lets a host point at a specific build instead (a
 * non-PATH install, a pinned version, or a locally patched goose).
 *
 * Dependency-light on purpose: both the remote-host store and the
 * `shared/api/remoteHosts` bridge import it, so it must not pull either in.
 * Paths and hostnames only — never secrets.
 */

export const REMOTE_HOST_GOOSE_PATH_STORAGE_KEY =
  "goose:remote-host-goose-path";

/**
 * Paths the remote script can resolve: absolute, or `~/`-relative to the
 * remote home. Bare relative paths are ambiguous remotely, and Rust rejects
 * them again before building any argv.
 */
export function isValidGoosePath(path: string): boolean {
  const trimmed = path.trim();
  if (trimmed === "") return false;
  if (/[\n\r\0]/.test(trimmed)) return false;
  if (trimmed.endsWith("/")) return false;
  return trimmed.startsWith("/") || trimmed.startsWith("~/");
}

/** Host -> goose binary path, tolerating any shape localStorage hands back. */
export function loadPersistedGoosePaths(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const stored = window.localStorage.getItem(
      REMOTE_HOST_GOOSE_PATH_STORAGE_KEY,
    );
    if (!stored) return {};
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const byHost: Record<string, string> = {};
    for (const [host, value] of Object.entries(parsed)) {
      if (typeof value !== "string") continue;
      const path = value.trim();
      if (host.trim() === "" || !isValidGoosePath(path)) continue;
      byHost[host] = path;
    }
    return byHost;
  } catch {
    return {};
  }
}

export function persistGoosePaths(byHost: Record<string, string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      REMOTE_HOST_GOOSE_PATH_STORAGE_KEY,
      JSON.stringify(byHost),
    );
  } catch {
    // localStorage may be unavailable
  }
}

/**
 * Current override for `host`, read straight from storage so callers outside
 * React (the Tauri bridge) never depend on store hydration order.
 */
export function getGoosePathForHost(host: string): string | undefined {
  return loadPersistedGoosePaths()[host.trim()];
}
