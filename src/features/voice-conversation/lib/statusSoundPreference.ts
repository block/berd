import { useCallback, useSyncExternalStore } from "react";

export type StatusSoundMode =
  | "continuous"
  | "continuous-while-working"
  | "once"
  | "off";

export interface StatusSoundPreference {
  mode: StatusSoundMode;
  volume: number;
}

const STORAGE_KEY = "goose:voice-status-sound-preference";
const CHANGED_EVENT = "goose:voice-status-sound-preference-changed";
const DEFAULT_PREFERENCE: StatusSoundPreference = {
  mode: "continuous-while-working",
  volume: 0.4,
};
const DEFAULT_SNAPSHOT = JSON.stringify(DEFAULT_PREFERENCE);
let volatilePreference: StatusSoundPreference | undefined;

function normalize(value: unknown): StatusSoundPreference {
  if (!value || typeof value !== "object") return DEFAULT_PREFERENCE;
  const candidate = value as Partial<StatusSoundPreference>;
  const mode =
    candidate.mode === "continuous" ||
    candidate.mode === "continuous-while-working" ||
    candidate.mode === "once" ||
    candidate.mode === "off"
      ? candidate.mode
      : DEFAULT_PREFERENCE.mode;
  const volume =
    typeof candidate.volume === "number" && Number.isFinite(candidate.volume)
      ? Math.min(1, Math.max(0, candidate.volume))
      : DEFAULT_PREFERENCE.volume;
  return { mode, volume };
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
