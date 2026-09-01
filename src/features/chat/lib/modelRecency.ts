import { useSyncExternalStore } from "react";

export const MODEL_RECENCY_STORAGE_KEY = "berd:model-recency-v1";
export const MODEL_RECENCY_CHANGED_EVENT = "berd:model-recency-v1-changed";

export const MODEL_RECENCY_LIMIT = 50;

export type ModelRecencyMap = Record<string, number>;

const EMPTY_MAP: ModelRecencyMap = {};

let cachedMap: ModelRecencyMap = EMPTY_MAP;
let cachedRaw: string | null | undefined;

function modelRecencyKey(
  agentId: string,
  model: { id: string; providerId?: string },
): string {
  return [agentId, model.providerId ?? "", model.id]
    .map(encodeURIComponent)
    .join("/");
}

export function getModelRecencyMap(): ModelRecencyMap {
  if (typeof window === "undefined") return EMPTY_MAP;

  let raw: string | null;
  try {
    raw = window.localStorage.getItem(MODEL_RECENCY_STORAGE_KEY);
  } catch {
    return cachedMap;
  }
  // useSyncExternalStore needs a stable snapshot identity between writes.
  if (raw === cachedRaw) return cachedMap;

  let map = EMPTY_MAP;
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        const next: ModelRecencyMap = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "number" && Number.isFinite(value)) {
            next[key] = value;
          }
        }
        map = next;
      }
    } catch {
      // Corrupt JSON is treated as empty.
    }
  }

  cachedRaw = raw;
  cachedMap = map;
  return map;
}

export function recordModelSelection(
  agentId: string,
  model: { id: string; providerId?: string },
): void {
  if (typeof window === "undefined") return;

  const key = modelRecencyKey(agentId, model);
  const currentMap = getModelRecencyMap();
  const entries = Object.entries(currentMap).filter(
    ([candidate]) => candidate !== key,
  );
  const highestRank = entries.reduce(
    (highest, [, rank]) => Math.max(highest, rank),
    Number.NEGATIVE_INFINITY,
  );
  const nextRank = Math.max(
    Date.now(),
    highestRank + 1,
    currentMap[key] ?? Number.NEGATIVE_INFINITY,
  );
  entries.push([key, nextRank]);
  entries.sort(
    ([leftKey, leftRank], [rightKey, rightRank]) =>
      leftRank - rightRank || leftKey.localeCompare(rightKey),
  );
  const nextMap = Object.fromEntries(entries.slice(-MODEL_RECENCY_LIMIT));
  if (JSON.stringify(nextMap) === cachedRaw) return;

  persistModelRecencyMap(nextMap);
  window.dispatchEvent(new CustomEvent(MODEL_RECENCY_CHANGED_EVENT));
}

function persistModelRecencyMap(map: ModelRecencyMap): void {
  try {
    const raw = JSON.stringify(map);
    window.localStorage.setItem(MODEL_RECENCY_STORAGE_KEY, raw);
    cachedRaw = raw;
    cachedMap = map;
  } catch {
    // localStorage can be unavailable in restricted contexts.
  }
}

export function getModelRecencyRank(
  map: ModelRecencyMap,
  agentId: string,
  model: { id: string; providerId?: string },
): number | null {
  const exact = map[modelRecencyKey(agentId, model)];
  if (exact !== undefined) return exact;

  return map[modelRecencyKey(agentId, { id: model.id })] ?? null;
}

const listeners = new Set<() => void>();
let removeWindowListeners: (() => void) | undefined;

function notifyListeners() {
  for (const listener of listeners) listener();
}

function handleStorageChange(event: StorageEvent) {
  if (event.key === MODEL_RECENCY_STORAGE_KEY || event.key === null) {
    notifyListeners();
  }
}

function subscribe(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};

  listeners.add(onStoreChange);
  if (!removeWindowListeners) {
    window.addEventListener(MODEL_RECENCY_CHANGED_EVENT, notifyListeners);
    window.addEventListener("storage", handleStorageChange);
    removeWindowListeners = () => {
      window.removeEventListener(MODEL_RECENCY_CHANGED_EVENT, notifyListeners);
      window.removeEventListener("storage", handleStorageChange);
    };
  }

  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0) {
      removeWindowListeners?.();
      removeWindowListeners = undefined;
    }
  };
}

export function useModelRecency(): ModelRecencyMap {
  return useSyncExternalStore(subscribe, getModelRecencyMap, () => EMPTY_MAP);
}
