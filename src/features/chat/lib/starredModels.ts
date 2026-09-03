const STARRED_MODELS_STORAGE_KEY = "goose:starredModels:v1";
const STARRED_MODELS_CHANGED_EVENT = "goose:starred-models-changed";

type StarredModelSet = Set<string>;

export function modelStarKey(scopeId: string, modelId: string): string {
  return JSON.stringify([scopeId, modelId]);
}

function readStarredModels(): StarredModelSet {
  if (typeof window === "undefined") {
    return new Set();
  }

  try {
    const stored = window.localStorage.getItem(STARRED_MODELS_STORAGE_KEY);
    if (!stored) {
      return new Set();
    }

    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return new Set();
    }

    return new Set(parsed.filter((item) => typeof item === "string"));
  } catch {
    return new Set();
  }
}

function persistStarredModels(models: StarredModelSet): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (models.size === 0) {
      window.localStorage.removeItem(STARRED_MODELS_STORAGE_KEY);
    } else {
      window.localStorage.setItem(
        STARRED_MODELS_STORAGE_KEY,
        JSON.stringify([...models]),
      );
    }
  } catch {
    // localStorage may be unavailable.
  }

  window.dispatchEvent(new CustomEvent(STARRED_MODELS_CHANGED_EVENT));
}

export function getStarredModelKeys(): StarredModelSet {
  return readStarredModels();
}

export function toggleModelStar(scopeId: string, modelId: string): void {
  const next = readStarredModels();
  const key = modelStarKey(scopeId, modelId);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  persistStarredModels(next);
}

export const STARRED_MODELS_EVENT = STARRED_MODELS_CHANGED_EVENT;
export const STARRED_MODELS_KEY = STARRED_MODELS_STORAGE_KEY;
