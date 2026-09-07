import { useCallback, useSyncExternalStore } from "react";
import type { ModelOption } from "../types";
import {
  getStarredModels,
  modelStarKey,
  STARRED_MODELS_CHANGED_EVENT,
  STARRED_MODELS_STORAGE_KEY,
  starredModelKey,
  toggleModelStar,
  type StarredModelRecord,
} from "../lib/starredModels";

const EMPTY_RECORDS: StarredModelRecord[] = [];
let cachedSnapshot: StarredModelRecord[] | null = null;

export function __resetStarredModelsCacheForTests(): void {
  cachedSnapshot = null;
}

function getSnapshot(): StarredModelRecord[] {
  cachedSnapshot ??= getStarredModels();
  return cachedSnapshot;
}

function subscribe(callback: () => void): () => void {
  const update = () => {
    cachedSnapshot = null;
    callback();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STARRED_MODELS_STORAGE_KEY)
      update();
  };
  window.addEventListener(STARRED_MODELS_CHANGED_EVENT, update);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(STARRED_MODELS_CHANGED_EVENT, update);
    window.removeEventListener("storage", onStorage);
  };
}

export function useStarredModels() {
  const starredModels = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY_RECORDS,
  );
  const starredKeys = new Set(starredModels.map(starredModelKey));
  const isStarred = useCallback(
    (agentId: string, model: ModelOption) =>
      starredKeys.has(modelStarKey(agentId, model.providerId, model.id)),
    [starredKeys],
  );

  return {
    starredModels,
    isStarred,
    toggleStar: useCallback((agentId: string, model: ModelOption) => {
      toggleModelStar(agentId, model);
    }, []),
  };
}
