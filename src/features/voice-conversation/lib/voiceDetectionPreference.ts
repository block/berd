import { useCallback, useSyncExternalStore } from "react";

export type VoiceDetectionSensitivity = "less" | "balanced" | "more";
export type EndOfSpeechPause = "short" | "standard" | "long";

export interface VoiceDetectionPreference {
  speechSensitivity: VoiceDetectionSensitivity;
  endOfSpeechPause: EndOfSpeechPause;
}

const STORAGE_KEY = "goose:voice-detection-preference";
const CHANGED_EVENT = "goose:voice-detection-preference-changed";
const DEFAULT_PREFERENCE: VoiceDetectionPreference = {
  speechSensitivity: "more",
  endOfSpeechPause: "standard",
};
const DEFAULT_SNAPSHOT = JSON.stringify(DEFAULT_PREFERENCE);
let volatilePreference:
  | {
      preference: VoiceDetectionPreference;
      storageValueBeforeWrite: string | null | undefined;
    }
  | undefined;
let removeVolatileStorageListener: (() => void) | undefined;

function normalize(value: unknown): VoiceDetectionPreference {
  if (!value || typeof value !== "object") return DEFAULT_PREFERENCE;
  const candidate = value as Partial<VoiceDetectionPreference>;
  return {
    speechSensitivity:
      candidate.speechSensitivity === "less" ||
      candidate.speechSensitivity === "balanced" ||
      candidate.speechSensitivity === "more"
        ? candidate.speechSensitivity
        : DEFAULT_PREFERENCE.speechSensitivity,
    endOfSpeechPause:
      candidate.endOfSpeechPause === "short" ||
      candidate.endOfSpeechPause === "standard" ||
      candidate.endOfSpeechPause === "long"
        ? candidate.endOfSpeechPause
        : DEFAULT_PREFERENCE.endOfSpeechPause,
  };
}

export function getDefaultVoiceDetectionPreference(): VoiceDetectionPreference {
  return DEFAULT_PREFERENCE;
}

export function getVoiceDetectionPreference(): VoiceDetectionPreference {
  if (typeof window === "undefined") return DEFAULT_PREFERENCE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (volatilePreference) {
      if (
        volatilePreference.storageValueBeforeWrite === undefined ||
        raw === volatilePreference.storageValueBeforeWrite
      ) {
        return volatilePreference.preference;
      }
      clearVolatilePreference();
    }
    return raw ? normalize(JSON.parse(raw)) : DEFAULT_PREFERENCE;
  } catch {
    return volatilePreference?.preference ?? DEFAULT_PREFERENCE;
  }
}

function getSnapshot(): string {
  return JSON.stringify(getVoiceDetectionPreference());
}

const listeners = new Set<() => void>();
let removeWindowListeners: (() => void) | undefined;

function notify() {
  for (const listener of listeners) listener();
}

function clearVolatilePreference() {
  volatilePreference = undefined;
  removeVolatileStorageListener?.();
  removeVolatileStorageListener = undefined;
}

function retainVolatilePreference(
  preference: VoiceDetectionPreference,
  storageValueBeforeWrite: string | null | undefined,
) {
  volatilePreference = { preference, storageValueBeforeWrite };
  if (removeVolatileStorageListener || typeof window === "undefined") return;
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    clearVolatilePreference();
    notify();
  };
  window.addEventListener("storage", handleStorage);
  removeVolatileStorageListener = () => {
    window.removeEventListener("storage", handleStorage);
  };
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

export function setVoiceDetectionPreference(
  preference: VoiceDetectionPreference,
): void {
  if (typeof window === "undefined") return;
  const value = normalize(preference);
  let storageValueBeforeWrite: string | null | undefined;
  try {
    storageValueBeforeWrite = window.localStorage.getItem(STORAGE_KEY);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    clearVolatilePreference();
  } catch {
    // Keep the current in-memory renderer usable when storage is unavailable.
    retainVolatilePreference(value, storageValueBeforeWrite);
  }
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: value }));
}

export function useVoiceDetectionPreference() {
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => DEFAULT_SNAPSHOT,
  );
  const preference = normalize(JSON.parse(snapshot));
  const setSpeechSensitivity = useCallback(
    (speechSensitivity: VoiceDetectionSensitivity) => {
      setVoiceDetectionPreference({
        ...getVoiceDetectionPreference(),
        speechSensitivity,
      });
    },
    [],
  );
  const setEndOfSpeechPause = useCallback(
    (endOfSpeechPause: EndOfSpeechPause) => {
      setVoiceDetectionPreference({
        ...getVoiceDetectionPreference(),
        endOfSpeechPause,
      });
    },
    [],
  );
  const reset = useCallback(() => {
    setVoiceDetectionPreference(DEFAULT_PREFERENCE);
  }, []);
  return {
    ...preference,
    setSpeechSensitivity,
    setEndOfSpeechPause,
    reset,
  };
}
