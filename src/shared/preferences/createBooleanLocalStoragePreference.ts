import { useCallback, useSyncExternalStore } from "react";

interface BooleanLocalStoragePreferenceOptions {
  storageKey: string;
  changedEvent: string;
  defaultValue?: boolean;
}

function readBooleanPreference(
  storageKey: string,
  defaultValue: boolean,
): boolean {
  if (typeof window === "undefined") return defaultValue;

  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "true") {
      return true;
    }
    if (stored === "false") {
      return false;
    }
    // Invalid stored values fall back to the caller's declared default.
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

export function createBooleanLocalStoragePreference({
  storageKey,
  changedEvent,
  defaultValue = true,
}: BooleanLocalStoragePreferenceOptions) {
  const get = () => readBooleanPreference(storageKey, defaultValue);
  const listeners = new Set<() => void>();
  const notifyListeners = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  let removeWindowListener: (() => void) | undefined;

  const handleStorageChange = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) {
      notifyListeners();
    }
  };

  const subscribe = (onStoreChange: () => void) => {
    if (typeof window === "undefined") return () => {};

    listeners.add(onStoreChange);

    if (!removeWindowListener) {
      window.addEventListener(changedEvent, notifyListeners);
      window.addEventListener("storage", handleStorageChange);
      removeWindowListener = () => {
        window.removeEventListener(changedEvent, notifyListeners);
        window.removeEventListener("storage", handleStorageChange);
      };
    }

    return () => {
      listeners.delete(onStoreChange);
      if (listeners.size === 0) {
        removeWindowListener?.();
        removeWindowListener = undefined;
      }
    };
  };

  const set = (enabled: boolean): void => {
    if (typeof window === "undefined") return;

    try {
      window.localStorage.setItem(storageKey, String(enabled));
    } catch {
      // localStorage can be unavailable in restricted contexts.
    }
    window.dispatchEvent(
      new CustomEvent(changedEvent, { detail: { enabled } }),
    );
  };

  const useValue = () => {
    const enabled = useSyncExternalStore(subscribe, get, () => defaultValue);
    const setEnabled = useCallback((nextEnabled: boolean) => {
      set(nextEnabled);
    }, []);

    return { enabled, setEnabled };
  };

  return { get, set, useValue };
}
