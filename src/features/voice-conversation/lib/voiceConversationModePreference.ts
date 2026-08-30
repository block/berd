import { useCallback, useSyncExternalStore } from "react";

export type VoiceConversationMode = "chained" | "openai-realtime";

const STORAGE_KEY = "goose:voice-conversation-mode";
const CHANGED_EVENT = "goose:voice-conversation-mode-changed";
let inMemoryMode: VoiceConversationMode | null = null;

function normalize(value: unknown): VoiceConversationMode {
  return value === "openai-realtime" ? value : "chained";
}

export function getVoiceConversationMode(): VoiceConversationMode {
  if (typeof window === "undefined") return "chained";
  if (inMemoryMode) return inMemoryMode;
  try {
    return normalize(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return "chained";
  }
}

const listeners = new Set<() => void>();
let removeWindowListeners: (() => void) | undefined;

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  if (typeof window === "undefined") return () => undefined;
  listeners.add(listener);
  if (!removeWindowListeners) {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) {
        inMemoryMode = null;
        notify();
      }
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

export function setVoiceConversationMode(mode: VoiceConversationMode): void {
  if (typeof window === "undefined") return;
  const value = normalize(mode);
  inMemoryMode = value;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Keep this renderer usable when persistent storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { value } }));
}

export function useVoiceConversationModePreference() {
  const mode = useSyncExternalStore(
    subscribe,
    getVoiceConversationMode,
    () => "chained" as const,
  );
  const setMode = useCallback((value: VoiceConversationMode) => {
    setVoiceConversationMode(value);
  }, []);
  return { mode, setMode };
}
