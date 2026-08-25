import { useCallback, useSyncExternalStore } from "react";

export type VoiceInterruptionMode =
  | "automatic"
  | "allowInterruptions"
  | "preventFeedback";
export type VoiceInterruptionSensitivity = "less" | "balanced" | "more";

export interface VoiceInterruptionPreference {
  mode: VoiceInterruptionMode;
  sensitivity: VoiceInterruptionSensitivity;
  speechSensitivity: VoiceInterruptionSensitivity;
}

const STORAGE_KEY = "goose:voice-interruption-preference";
const CHANGED_EVENT = "goose:voice-interruption-preference-changed";
const DEFAULT_PREFERENCE: VoiceInterruptionPreference = {
  mode: "automatic",
  sensitivity: "less",
  speechSensitivity: "more",
};
const DEFAULT_SNAPSHOT = JSON.stringify(DEFAULT_PREFERENCE);
let volatilePreference:
  | {
      preference: VoiceInterruptionPreference;
      storageValueBeforeWrite: string | null | undefined;
    }
  | undefined;
let removeVolatileStorageListener: (() => void) | undefined;

function normalize(value: unknown): VoiceInterruptionPreference {
  if (!value || typeof value !== "object") return DEFAULT_PREFERENCE;
  const candidate = value as Partial<VoiceInterruptionPreference>;
  const mode =
    candidate.mode === "automatic" ||
    candidate.mode === "allowInterruptions" ||
    candidate.mode === "preventFeedback"
      ? candidate.mode
      : DEFAULT_PREFERENCE.mode;
  const sensitivity =
    candidate.sensitivity === "less" ||
    candidate.sensitivity === "balanced" ||
    candidate.sensitivity === "more"
      ? candidate.sensitivity
      : DEFAULT_PREFERENCE.sensitivity;
  const speechSensitivity =
    candidate.speechSensitivity === "less" ||
    candidate.speechSensitivity === "balanced" ||
    candidate.speechSensitivity === "more"
      ? candidate.speechSensitivity
      : DEFAULT_PREFERENCE.speechSensitivity;
  return { mode, sensitivity, speechSensitivity };
}

export function getDefaultVoiceInterruptionPreference(): VoiceInterruptionPreference {
  return DEFAULT_PREFERENCE;
}

export function getVoiceInterruptionPreference(): VoiceInterruptionPreference {
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
  return JSON.stringify(getVoiceInterruptionPreference());
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
  preference: VoiceInterruptionPreference,
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
      if (event.key === STORAGE_KEY || event.key === null) {
        clearVolatilePreference();
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

export function setVoiceInterruptionPreference(
  preference: VoiceInterruptionPreference,
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

export function useVoiceInterruptionPreference() {
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => DEFAULT_SNAPSHOT,
  );
  const preference = normalize(JSON.parse(snapshot));
  const setMode = useCallback((mode: VoiceInterruptionMode) => {
    setVoiceInterruptionPreference({
      ...getVoiceInterruptionPreference(),
      mode,
    });
  }, []);
  const setSensitivity = useCallback(
    (sensitivity: VoiceInterruptionSensitivity) => {
      setVoiceInterruptionPreference({
        ...getVoiceInterruptionPreference(),
        sensitivity,
      });
    },
    [],
  );
  const setSpeechSensitivity = useCallback(
    (speechSensitivity: VoiceInterruptionSensitivity) => {
      setVoiceInterruptionPreference({
        ...getVoiceInterruptionPreference(),
        speechSensitivity,
      });
    },
    [],
  );
  const resetSensitivities = useCallback(() => {
    setVoiceInterruptionPreference({
      ...getVoiceInterruptionPreference(),
      sensitivity: DEFAULT_PREFERENCE.sensitivity,
      speechSensitivity: DEFAULT_PREFERENCE.speechSensitivity,
    });
  }, []);
  return {
    ...preference,
    setMode,
    setSensitivity,
    setSpeechSensitivity,
    resetSensitivities,
  };
}
