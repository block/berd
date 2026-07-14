import { useCallback, useSyncExternalStore } from "react";

export const ARTIFACT_AUTO_OPEN_STORAGE_KEY = "goose:artifact-auto-open";
export const DEFAULT_ARTIFACT_AUTO_OPEN = true;

const ARTIFACT_AUTO_OPEN_CHANGED_EVENT = "goose:artifact-auto-open-changed";

function normalize(value: unknown): boolean {
  // Only an explicit "false" disables it; default (and anything else) is on.
  return !(value === "false" || value === false);
}

function read(): boolean {
  try {
    const stored = localStorage.getItem(ARTIFACT_AUTO_OPEN_STORAGE_KEY);
    if (stored === null) return DEFAULT_ARTIFACT_AUTO_OPEN;
    return normalize(stored);
  } catch {
    return DEFAULT_ARTIFACT_AUTO_OPEN;
  }
}

const listeners = new Set<() => void>();
let removeWindowListener: (() => void) | undefined;

function notifyListeners() {
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  if (!removeWindowListener) {
    window.addEventListener(ARTIFACT_AUTO_OPEN_CHANGED_EVENT, notifyListeners);
    removeWindowListener = () => {
      window.removeEventListener(
        ARTIFACT_AUTO_OPEN_CHANGED_EVENT,
        notifyListeners,
      );
    };
  }
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0) {
      removeWindowListener?.();
      removeWindowListener = undefined;
    }
  };
}

export function getArtifactAutoOpen(): boolean {
  return read();
}

export function setArtifactAutoOpen(enabled: boolean): void {
  try {
    localStorage.setItem(
      ARTIFACT_AUTO_OPEN_STORAGE_KEY,
      enabled ? "true" : "false",
    );
  } catch {
    // localStorage can be unavailable in restricted contexts.
  }
  window.dispatchEvent(
    new CustomEvent(ARTIFACT_AUTO_OPEN_CHANGED_EVENT, { detail: { enabled } }),
  );
}

export function useArtifactAutoOpenPreference() {
  const enabled = useSyncExternalStore(
    subscribe,
    read,
    () => DEFAULT_ARTIFACT_AUTO_OPEN,
  );
  const setEnabled = useCallback((next: boolean) => {
    setArtifactAutoOpen(next);
  }, []);
  return { enabled, setEnabled };
}
