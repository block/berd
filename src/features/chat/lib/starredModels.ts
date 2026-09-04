import { toast } from "sonner";
import { i18n } from "@/shared/i18n";

export const STARRED_MODELS_ENTRY_PREFIX = "goose:starredModels:v1:entry:";
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

function readStarredModels(): StarredModelSet {
  if (typeof window === "undefined") {
    return new Set();
  }

  try {
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
function persistStarEntry(starKey: string, starred: boolean): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const storageKey = starredModelStorageKey(starKey);
    if (starred) {
      window.localStorage.setItem(storageKey, STARRED_MODELS_ENTRY_VALUE);
    } else {
      window.localStorage.removeItem(storageKey);
    }
  } catch {
    // The write did not land (storage unavailable or over quota). Tell the
    // user instead of letting the toggle silently bounce back.
    toast.error(i18n.t("chat:notifications.starredModelsPersistError"));
    window.dispatchEvent(new CustomEvent(STARRED_MODELS_CHANGED_EVENT));
    return false;
  }

  window.dispatchEvent(new CustomEvent(STARRED_MODELS_CHANGED_EVENT));
  return true;
}

export function getStarredModelKeys(): StarredModelSet {
  return readStarredModels();
}

export function toggleModelStar(scopeId: string, modelId: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const starKey = modelStarKey(scopeId, modelId);

  try {
    const starred =
      window.localStorage.getItem(starredModelStorageKey(starKey)) !== null;
    return persistStarEntry(starKey, !starred);
  } catch {
    // Storage is unavailable, so the toggle cannot be applied at all. The
    // write path reports its own failures; report this one too.
    toast.error(i18n.t("chat:notifications.starredModelsPersistError"));
    return false;
  }
}

export const STARRED_MODELS_EVENT = STARRED_MODELS_CHANGED_EVENT;
