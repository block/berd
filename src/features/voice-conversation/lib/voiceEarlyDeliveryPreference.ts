import { useCallback, useSyncExternalStore } from "react";

export interface VoiceEarlyDeliveryPreference {
  enabled: boolean;
}

const STORAGE_KEY = "goose:voice-early-delivery-preference";
const CHANGED_EVENT = "goose:voice-early-delivery-preference-changed";
const DEFAULT_PREFERENCE: VoiceEarlyDeliveryPreference = {
  enabled: true,
};
const DEFAULT_SNAPSHOT = JSON.stringify(DEFAULT_PREFERENCE);
let volatilePreference:
  | {
      preference: VoiceEarlyDeliveryPreference;
      storageValueBeforeWrite: string | null | undefined;
    }
  | undefined;
let removeVolatileStorageListener: (() => void) | undefined;

function normalize(value: unknown): VoiceEarlyDeliveryPreference {
  if (!value || typeof value !== "object") return DEFAULT_PREFERENCE;
  const candidate = value as Partial<VoiceEarlyDeliveryPreference>;
  return {
    enabled:
      typeof candidate.enabled === "boolean"
        ? candidate.enabled
        : DEFAULT_PREFERENCE.enabled,
  };
}

export function getDefaultVoiceEarlyDeliveryPreference(): VoiceEarlyDeliveryPreference {
  return DEFAULT_PREFERENCE;
}

export function getVoiceEarlyDeliveryPreference(): VoiceEarlyDeliveryPreference {
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
  return JSON.stringify(getVoiceEarlyDeliveryPreference());
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
  preference: VoiceEarlyDeliveryPreference,
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

export function subscribeToVoiceEarlyDeliveryPreference(listener: () => void) {
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

export function setVoiceEarlyDeliveryPreference(
  preference: VoiceEarlyDeliveryPreference,
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

export function useVoiceEarlyDeliveryPreference() {
  const snapshot = useSyncExternalStore(
    subscribeToVoiceEarlyDeliveryPreference,
    getSnapshot,
    () => DEFAULT_SNAPSHOT,
  );
  const preference = normalize(JSON.parse(snapshot));
  const setEnabled = useCallback((enabled: boolean) => {
    setVoiceEarlyDeliveryPreference({
      ...getVoiceEarlyDeliveryPreference(),
      enabled,
    });
  }, []);
  return { ...preference, setEnabled };
}
