import { useCallback, useSyncExternalStore } from "react";
import type { RealtimeSessionOverrides } from "./realtimeEmissaryProtocol";

export interface RealtimeVoicePreference {
  model: string;
  transcriptionModel: string;
  voice: string;
  speed: number;
  sessionOverridesText: string;
}

const DEFAULT_PREFERENCE: RealtimeVoicePreference = {
  model: "gpt-realtime",
  transcriptionModel: "gpt-4o-mini-transcribe",
  voice: "marin",
  speed: 1,
  sessionOverridesText: "{}",
};
const STORAGE_KEY = "goose:openai-realtime-voice-options";
const CHANGED_EVENT = "goose:openai-realtime-voice-options-changed";
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedPreference = DEFAULT_PREFERENCE;

export function getRealtimeVoicePreference(): RealtimeVoicePreference {
  if (typeof window === "undefined") return DEFAULT_PREFERENCE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === cachedRaw) return cachedPreference;
    const parsed = JSON.parse(raw ?? "{}");
    cachedRaw = raw;
    cachedPreference = {
      model:
        typeof parsed.model === "string" && parsed.model.trim()
          ? parsed.model
          : DEFAULT_PREFERENCE.model,
      transcriptionModel:
        typeof parsed.transcriptionModel === "string" &&
        parsed.transcriptionModel.trim()
          ? parsed.transcriptionModel
          : DEFAULT_PREFERENCE.transcriptionModel,
      voice:
        typeof parsed.voice === "string" && parsed.voice.trim()
          ? parsed.voice
          : DEFAULT_PREFERENCE.voice,
      speed:
        typeof parsed.speed === "number" &&
        Number.isFinite(parsed.speed) &&
        parsed.speed >= 0.25 &&
        parsed.speed <= 1.5
          ? parsed.speed
          : DEFAULT_PREFERENCE.speed,
      sessionOverridesText:
        typeof parsed.sessionOverridesText === "string"
          ? parsed.sessionOverridesText
          : DEFAULT_PREFERENCE.sessionOverridesText,
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

export function setRealtimeVoicePreference(
  preference: RealtimeVoicePreference,
): void {
  const raw = JSON.stringify(preference);
  window.localStorage.setItem(STORAGE_KEY, raw);
  cachedRaw = raw;
  cachedPreference = preference;
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

export function parseRealtimeSessionOverrides(
  text: string,
): RealtimeSessionOverrides {
  const parsed: unknown = JSON.parse(text || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Realtime session overrides must be a JSON object.");
  }
  return parsed as RealtimeSessionOverrides;
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
