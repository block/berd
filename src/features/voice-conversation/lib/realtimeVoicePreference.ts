import { useCallback, useSyncExternalStore } from "react";
import { DEFAULT_OPENAI_VOICE } from "./openAiVoiceOptions";

export type RealtimePresentationMode = "debug" | "subtle";

export interface RealtimeVoicePreference {
  presentationMode: RealtimePresentationMode;
  voice: string;
}

const DEFAULT_PREFERENCE: RealtimeVoicePreference = {
  presentationMode: import.meta.env.DEV ? "debug" : "subtle",
  voice: DEFAULT_OPENAI_VOICE,
};
const STORAGE_KEY = "goose:openai-realtime-voice-options";
const CHANGED_EVENT = "goose:openai-realtime-voice-options-changed";
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedPreference = DEFAULT_PREFERENCE;

export function getDefaultRealtimeVoicePreference(): RealtimeVoicePreference {
  return { ...DEFAULT_PREFERENCE };
}

export function getRealtimeVoicePreference(): RealtimeVoicePreference {
  if (typeof window === "undefined") return DEFAULT_PREFERENCE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === cachedRaw) return cachedPreference;
    const parsed = JSON.parse(raw ?? "{}") as Record<string, unknown>;
    cachedRaw = raw;
    cachedPreference = {
      presentationMode:
        parsed.presentationMode === "debug" ||
        parsed.presentationMode === "subtle"
          ? parsed.presentationMode
          : DEFAULT_PREFERENCE.presentationMode,
      voice:
        typeof parsed.voice === "string" && parsed.voice.trim()
          ? parsed.voice
          : DEFAULT_PREFERENCE.voice,
    };
    return cachedPreference;
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const notify = () => listener();
  window.addEventListener(CHANGED_EVENT, notify);
  return () => {
    listeners.delete(listener);
    window.removeEventListener(CHANGED_EVENT, notify);
  };
}

export function subscribeToRealtimeVoicePreference(
  listener: (preference: RealtimeVoicePreference) => void,
): () => void {
  return subscribe(() => listener(getRealtimeVoicePreference()));
}

export function setRealtimeVoicePreference(
  preference: RealtimeVoicePreference,
): void {
  const raw = JSON.stringify(preference);
  window.localStorage.setItem(STORAGE_KEY, raw);
  cachedRaw = raw;
  cachedPreference = preference;
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

export function useRealtimeVoicePreference() {
  const preference = useSyncExternalStore(
    subscribe,
    getRealtimeVoicePreference,
    () => DEFAULT_PREFERENCE,
  );
  const setPreference = useCallback((value: RealtimeVoicePreference) => {
    setRealtimeVoicePreference(value);
  }, []);
  return { preference, setPreference };
}
