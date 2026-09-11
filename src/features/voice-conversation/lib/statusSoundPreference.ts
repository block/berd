import { useCallback, useSyncExternalStore } from "react";

export type StatusSoundMode = "off" | "working" | "working-and-waiting";

export interface StatusSoundPreference {
  mode: StatusSoundMode;
}

const STORAGE_KEY = "goose:voice-status-sound-preference";
const CHANGED_EVENT = "goose:voice-status-sound-preference-changed";
const DEFAULT_PREFERENCE: StatusSoundPreference = {
  mode: "working",
};
const NORMALIZED_MODES: Record<string, StatusSoundMode> = {
  continuous: "working-and-waiting",
  "continuous-while-working": "working",
  off: "off",
  once: "working",
  working: "working",
  "working-and-waiting": "working-and-waiting",
};
const DEFAULT_SNAPSHOT = JSON.stringify(DEFAULT_PREFERENCE);
let volatilePreference: StatusSoundPreference | undefined;

function normalize(value: unknown): StatusSoundPreference {
  if (!value || typeof value !== "object") return DEFAULT_PREFERENCE;
  const candidate = value as { mode?: unknown };
  const mode =
    typeof candidate.mode === "string"
      ? (NORMALIZED_MODES[candidate.mode] ?? DEFAULT_PREFERENCE.mode)
      : DEFAULT_PREFERENCE.mode;
  return { mode };
}

export function getDefaultStatusSoundPreference(): StatusSoundPreference {
  return DEFAULT_PREFERENCE;
}

export function getStatusSoundPreference(): StatusSoundPreference {
  if (typeof window === "undefined") return DEFAULT_PREFERENCE;
  if (volatilePreference) return volatilePreference;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalize(JSON.parse(raw)) : DEFAULT_PREFERENCE;
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

function getSnapshot(): string {
  return JSON.stringify(getStatusSoundPreference());
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
      if (event.key === STORAGE_KEY || event.key === null) {
        volatilePreference = undefined;
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

export function setStatusSoundPreference(
  preference: StatusSoundPreference,
): void {
  if (typeof window === "undefined") return;
  const value = normalize(preference);
  volatilePreference = value;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    volatilePreference = undefined;
  } catch {
    // Keep the current renderer usable when persistent storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: value }));
}

export function subscribeToStatusSoundPreference(
  listener: (preference: StatusSoundPreference) => void,
): () => void {
  return subscribe(() => listener(getStatusSoundPreference()));
}

export function useStatusSoundPreference() {
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => DEFAULT_SNAPSHOT,
  );
  const preference = normalize(JSON.parse(snapshot));
  const update = useCallback((patch: Partial<StatusSoundPreference>) => {
    setStatusSoundPreference({ ...getStatusSoundPreference(), ...patch });
  }, []);
  return { ...preference, update };
}
