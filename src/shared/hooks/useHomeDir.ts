import { useEffect, useSyncExternalStore } from "react";
import {
  getCachedHomeDir,
  getHomeDir,
  subscribeHomeDir,
} from "@/shared/api/system";

/**
 * The user's home directory, or null until it resolves (one shared IPC call
 * for the whole app; instant after that). Used to expand `~`-prefixed paths
 * so cache keys and backend calls agree on one canonical spelling.
 *
 * Reads through the shared store rather than per-instance state: a transient
 * lookup failure clears the shared request so a later mount retries, and when
 * any retry succeeds every mounted consumer — including ones whose own mount
 * kicked off the failed attempt — observes the resolved dir instead of
 * staying null (which would leave `~`-path git observers disabled forever).
 */
export function useHomeDir(): string | null {
  const homeDir = useSyncExternalStore(subscribeHomeDir, getCachedHomeDir);

  useEffect(() => {
    if (homeDir !== null) {
      return;
    }

    getHomeDir().catch(() => {
      // Not resolvable (e.g. non-desktop runtime): leave paths unexpanded.
    });
  }, [homeDir]);

  return homeDir;
}
