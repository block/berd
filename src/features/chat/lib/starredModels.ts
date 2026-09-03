export const STARRED_MODELS_ENTRY_PREFIX = "goose:starredModels:v1:entry:";
export const LEGACY_STARRED_MODELS_STORAGE_KEY = "goose:starredModels:v1";
const STARRED_MODELS_ENTRY_VALUE = "1";
const STARRED_MODELS_CHANGED_EVENT = "goose:starred-models-changed";

type StarredModelSet = Set<string>;

export function modelStarKey(scopeId: string, modelId: string): string {
  return JSON.stringify([scopeId, modelId]);
}

/** localStorage key of the single entry that records one starred model. */
export function starredModelStorageKey(starKey: string): string {
  return STARRED_MODELS_ENTRY_PREFIX + encodeURIComponent(starKey);
}

/**
 * One-shot migration from the pre-#287 aggregate format (one array under a
 * single key). Idempotent and safe to race across windows: entry writes are
 * identical values, and removing the legacy key twice is a no-op.
 */
function migrateLegacyStarredModels(): void {
  const legacy = window.localStorage.getItem(LEGACY_STARRED_MODELS_STORAGE_KEY);
  if (legacy === null) {
    return;
  }

  window.localStorage.removeItem(LEGACY_STARRED_MODELS_STORAGE_KEY);

  try {
    const parsed: unknown = JSON.parse(legacy);
    if (!Array.isArray(parsed)) {
      return;
    }
    for (const item of parsed) {
      if (typeof item === "string") {
        window.localStorage.setItem(
          starredModelStorageKey(item),
          STARRED_MODELS_ENTRY_VALUE,
        );
      }
    }
  } catch {
    // Unreadable legacy value; the key has already been removed.
  }
}

function readStarredModels(): StarredModelSet {
  if (typeof window === "undefined") {
    return new Set();
  }

  try {
    migrateLegacyStarredModels();
    const storage = window.localStorage;
    const starred = new Set<string>();
    for (let i = 0; i < storage.length; i += 1) {
      const storageKey = storage.key(i);
      if (!storageKey?.startsWith(STARRED_MODELS_ENTRY_PREFIX)) {
        continue;
      }
      try {
        starred.add(
          decodeURIComponent(
            storageKey.slice(STARRED_MODELS_ENTRY_PREFIX.length),
          ),
        );
      } catch {
        // Skip a malformed entry rather than dropping every star.
      }
    }
    return starred;
  } catch {
    return new Set();
  }
}

/**
 * Write or clear exactly one star entry. Touching a single key (instead of
 * rewriting an aggregate array) removes the cross-window read-modify-write
 * race where concurrent toggles from different windows could drop each
 * other's stars. Note that two windows toggling the same model at the same
 * instant can still interleave; per-model state stays consistent either way.
 */
function persistStarEntry(starKey: string, starred: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const storageKey = starredModelStorageKey(starKey);
    if (starred) {
      window.localStorage.setItem(storageKey, STARRED_MODELS_ENTRY_VALUE);
    } else {
      window.localStorage.removeItem(storageKey);
    }
  } catch {
    // localStorage may be unavailable or over quota.
  }

  window.dispatchEvent(new CustomEvent(STARRED_MODELS_CHANGED_EVENT));
}

export function getStarredModelKeys(): StarredModelSet {
  return readStarredModels();
}

export function toggleModelStar(scopeId: string, modelId: string): void {
  if (typeof window === "undefined") {
    return;
  }

  const starKey = modelStarKey(scopeId, modelId);

  try {
    migrateLegacyStarredModels();
    const starred =
      window.localStorage.getItem(starredModelStorageKey(starKey)) !== null;
    persistStarEntry(starKey, !starred);
  } catch {
    // localStorage may be unavailable; leave stored state untouched.
  }
}

export const STARRED_MODELS_EVENT = STARRED_MODELS_CHANGED_EVENT;
