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
  try {
    const stored = localStorage.getItem(storageKey);
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

  const subscribe = (onStoreChange: () => void) => {
    listeners.add(onStoreChange);

    if (!removeWindowListener) {
      window.addEventListener(changedEvent, notifyListeners);
      removeWindowListener = () => {
        window.removeEventListener(changedEvent, notifyListeners);
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
    try {
      localStorage.setItem(storageKey, String(enabled));
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
