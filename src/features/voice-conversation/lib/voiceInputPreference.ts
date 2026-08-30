import { useCallback, useSyncExternalStore } from "react";
import type { MacSpeechStatus } from "../api/macSpeech";

export type VoiceInputBackend = "parakeet" | "macos" | "openai";

const STORAGE_KEY = "goose:voice-input-backend";
const CHANGED_EVENT = "goose:voice-input-backend-changed";
let inMemoryBackend: VoiceInputBackend | null = null;

function normalizeStored(value: unknown): VoiceInputBackend | null {
  return value === "parakeet" || value === "macos" || value === "openai"
    ? value
    : null;
}

export function getStoredVoiceInputBackend(): VoiceInputBackend | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = normalizeStored(window.localStorage.getItem(STORAGE_KEY));
    if (stored) inMemoryBackend = stored;
    return stored ?? inMemoryBackend;
  } catch {
    return inMemoryBackend;
  }
}

export function resolveVoiceInputBackend(
  stored: VoiceInputBackend | null,
  macSpeechAvailable: boolean | null,
): VoiceInputBackend | null {
  if (macSpeechAvailable === null) return null;
  if (stored === "parakeet") return "parakeet";
  if (stored === "openai") return "openai";
  if (stored === "macos" && macSpeechAvailable) return "macos";
  return macSpeechAvailable ? "macos" : "parakeet";
}

export function isMacSpeechAvailable(
  status: Pick<MacSpeechStatus, "supported" | "localeSupported"> | null,
  loading: boolean,
): boolean | null {
  if (!status) return loading ? null : false;
  return status.supported && status.localeSupported;
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
      if (event.key === null) {
        inMemoryBackend = null;
        notify();
        return;
      }
      if (event.key !== STORAGE_KEY) return;
      if (event.newValue === null) {
        inMemoryBackend = null;
        notify();
        return;
      }
      const backend = normalizeStored(event.newValue);
      if (!backend) return;
      inMemoryBackend = backend;
      notify();
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
  inMemoryBackend = backend;
  try {
    window.localStorage.setItem(STORAGE_KEY, backend);
  } catch {
    // Keep the current in-memory renderer usable when storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { backend } }));
}

export function useVoiceInputPreference(macSpeechAvailable: boolean | null) {
  const stored = useSyncExternalStore(
    subscribe,
    getStoredVoiceInputBackend,
    () => null,
  );
  const backend = resolveVoiceInputBackend(stored, macSpeechAvailable);
  const setBackend = useCallback((value: VoiceInputBackend) => {
    setVoiceInputBackend(value);
  }, []);
  return { backend, setBackend };
}
