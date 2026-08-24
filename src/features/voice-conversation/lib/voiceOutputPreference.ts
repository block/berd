import { useCallback, useSyncExternalStore } from "react";
import { getPlatform } from "@/shared/lib/platform";

export type VoiceOutputBackend = "pocket" | "siri";

const STORAGE_KEY = "goose:voice-output-backend";
const CHANGED_EVENT = "goose:voice-output-backend-changed";
export function getDefaultVoiceOutputBackend(): VoiceOutputBackend {
  return getPlatform() === "mac" ? "siri" : "pocket";
}

function normalize(value: unknown): VoiceOutputBackend {
  if (value === "siri") {
    return getPlatform() === "mac" ? "siri" : "pocket";
  }
  return value === "pocket" ? value : getDefaultVoiceOutputBackend();
}

export function getVoiceOutputBackend(): VoiceOutputBackend {
  if (typeof window === "undefined") return getDefaultVoiceOutputBackend();
  try {
    return normalize(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return getDefaultVoiceOutputBackend();
  }
}

const listeners = new Set<() => void>();
let removeWindowListeners: (() => void) | undefined;

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  if (typeof window === "undefined") return () => {};
  listeners.add(listener);
  if (!removeWindowListeners) {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) notify();
    };
    window.addEventListener(CHANGED_EVENT, notify);
    window.addEventListener("storage", handleStorage);
    removeWindowListeners = () => {
      window.removeEventListener(CHANGED_EVENT, notify);
      window.removeEventListener("storage", handleStorage);
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      removeWindowListeners?.();
      removeWindowListeners = undefined;
    }
  };
}

export function setVoiceOutputBackend(backend: VoiceOutputBackend): void {
  if (typeof window === "undefined") return;
  const value = normalize(backend);
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Keep the current in-memory renderer usable when storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { value } }));
}

export function useVoiceOutputPreference() {
  const backend = useSyncExternalStore(
    subscribe,
    getVoiceOutputBackend,
    getDefaultVoiceOutputBackend,
  );
  const setBackend = useCallback((value: VoiceOutputBackend) => {
    setVoiceOutputBackend(value);
  }, []);
  return { backend, setBackend };
}
