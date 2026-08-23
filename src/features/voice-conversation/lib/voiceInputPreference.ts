import { useCallback, useSyncExternalStore } from "react";

export type VoiceInputBackend = "parakeet" | "macos";

const STORAGE_KEY = "goose:voice-input-backend";
const CHANGED_EVENT = "goose:voice-input-backend-changed";

function normalizeStored(value: unknown): VoiceInputBackend | null {
  return value === "parakeet" || value === "macos" ? value : null;
}

export function getStoredVoiceInputBackend(): VoiceInputBackend | null {
  if (typeof window === "undefined") return null;
  try {
    return normalizeStored(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function resolveVoiceInputBackend(
  stored: VoiceInputBackend | null,
  macSpeechSupported: boolean | null,
): VoiceInputBackend | null {
  if (macSpeechSupported === null) return null;
  if (stored === "parakeet") return "parakeet";
  if (stored === "macos" && macSpeechSupported) return "macos";
  return macSpeechSupported ? "macos" : "parakeet";
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

export function setVoiceInputBackend(backend: VoiceInputBackend): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, backend);
  } catch {
    // Keep the current in-memory renderer usable when storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { backend } }));
}

export function useVoiceInputPreference(macSpeechSupported: boolean | null) {
  const stored = useSyncExternalStore(
    subscribe,
    getStoredVoiceInputBackend,
    () => null,
  );
  const backend = resolveVoiceInputBackend(stored, macSpeechSupported);
  const setBackend = useCallback((value: VoiceInputBackend) => {
    setVoiceInputBackend(value);
  }, []);
  return { backend, setBackend };
}
