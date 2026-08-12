import { createBooleanLocalStoragePreference } from "@/shared/preferences/createBooleanLocalStoragePreference";

export const MULTI_WORKSPACE_STORAGE_KEY = "goose:multi-workspace-enabled";
const MULTI_WORKSPACE_CHANGED_EVENT = "goose:multi-workspace-changed";
const LEGACY_EXPERIMENT_STORAGE_KEY = "goose:experimental-features";
const LEGACY_MULTI_WORKSPACE_EXPERIMENT_ID = "multi-workspace";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage ?? null;
}

function migrateLegacyPreference(): void {
  const storage = getStorage();
  if (!storage) return;

  try {
    if (storage.getItem(MULTI_WORKSPACE_STORAGE_KEY) !== null) {
      return;
    }

    const raw = storage.getItem(LEGACY_EXPERIMENT_STORAGE_KEY);
    if (!raw) {
      return;
    }

    const stored = JSON.parse(raw);
    if (
      !isRecord(stored) ||
      (stored.version !== 1 && stored.version !== 2) ||
      !isRecord(stored.experiments)
    ) {
      return;
    }

    const legacyPreference =
      stored.experiments[LEGACY_MULTI_WORKSPACE_EXPERIMENT_ID];
    if (
      isRecord(legacyPreference) &&
      typeof legacyPreference.enabled === "boolean"
    ) {
      storage.setItem(
        MULTI_WORKSPACE_STORAGE_KEY,
        String(legacyPreference.enabled),
      );
    }
  } catch {
    // Migration is best-effort; disabled is the safe fallback.
  }
}

const multiWorkspacePreference = createBooleanLocalStoragePreference({
  storageKey: MULTI_WORKSPACE_STORAGE_KEY,
  changedEvent: MULTI_WORKSPACE_CHANGED_EVENT,
  defaultValue: false,
});

export function getMultiWorkspaceEnabled(): boolean {
  migrateLegacyPreference();
  return multiWorkspacePreference.get();
}

export const setMultiWorkspaceEnabled = multiWorkspacePreference.set;

export function useMultiWorkspacePreference() {
  migrateLegacyPreference();
  return multiWorkspacePreference.useValue();
}
