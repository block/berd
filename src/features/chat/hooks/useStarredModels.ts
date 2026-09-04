import { useCallback, useSyncExternalStore } from "react";
import {
  getStarredModelKeys,
  modelStarKey,
  STARRED_MODELS_ENTRY_PREFIX,
  STARRED_MODELS_EVENT,
  toggleModelStar,
} from "../lib/starredModels";

let cachedSnapshot: Set<string> | null = null;
const serverSnapshot = new Set<string>();

/** Invalidate the in-memory snapshot cache. Intended for tests. */
export function __resetStarredModelsCacheForTests(): void {
  cachedSnapshot = null;
}

function getSnapshot(): Set<string> {
  if (cachedSnapshot === null) {
    cachedSnapshot = getStarredModelKeys();
  }
  return cachedSnapshot;
}

function subscribe(callback: () => void): () => void {
  const handleChange = () => {
    cachedSnapshot = null;
    callback();
  };
  const handleStorage = (event: StorageEvent) => {
    // Star entries live under per-key storage, so any entry write or removal
    // in another window changes the set. `key === null` covers localStorage
    // clears.
    if (
      event.key === null ||
      event.key.startsWith(STARRED_MODELS_ENTRY_PREFIX)
    ) {
      handleChange();
    }
  };

  window.addEventListener(STARRED_MODELS_EVENT, handleChange);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(STARRED_MODELS_EVENT, handleChange);
    window.removeEventListener("storage", handleStorage);
  };
}

export function useStarredModels() {
  const starredKeys = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => serverSnapshot,
  );
  const isStarred = useCallback(
    (scopeId: string, modelId: string) =>
      starredKeys.has(modelStarKey(scopeId, modelId)),
    [starredKeys],
  );
  const toggleStar = useCallback(
    (scopeId: string, modelId: string) => toggleModelStar(scopeId, modelId),
    [],
  );

  return { isStarred, toggleStar, starredKeys };
}
