import { useCallback, useSyncExternalStore } from "react";

export type RealtimeTurnDetection = "server_vad" | "semantic_vad";
export type RealtimeEagerness = "low" | "medium" | "high" | "auto";
export type RealtimeNoiseReduction = "off" | "near_field" | "far_field";
export type RealtimePresentationMode = "debug" | "subtle";
export type RealtimeReasoningEffort =
  | "default"
  | "none"
  | "low"
  | "medium"
  | "high";

export interface RealtimeVoicePreference {
  presentationMode: RealtimePresentationMode;
  model: string;
  transcriptionModel: string;
  voice: string;
  speed: number;
  turnDetection: RealtimeTurnDetection;
  eagerness: RealtimeEagerness;
  interruptResponse: boolean;
  createResponse: boolean;
  vadThreshold: number;
  prefixPaddingMs: number;
  silenceDurationMs: number;
  idleTimeoutMs: number | null;
  noiseReduction: RealtimeNoiseReduction;
  transcriptionLanguage: string;
  transcriptionPrompt: string;
  reasoningEffort: RealtimeReasoningEffort;
  maxOutputTokens: number | null;
}

const DEFAULT_PREFERENCE: RealtimeVoicePreference = {
  presentationMode: import.meta.env.DEV ? "debug" : "subtle",
  model: "gpt-realtime-2.1",
  transcriptionModel: "gpt-realtime-whisper",
  voice: "marin",
  speed: 1,
  turnDetection: "server_vad",
  eagerness: "auto",
  interruptResponse: true,
  createResponse: true,
  vadThreshold: 0.5,
  prefixPaddingMs: 300,
  silenceDurationMs: 500,
  idleTimeoutMs: null,
  noiseReduction: "off",
  transcriptionLanguage: "",
  transcriptionPrompt: "",
  reasoningEffort: "default",
  maxOutputTokens: null,
};
const STORAGE_KEY = "goose:openai-realtime-voice-options";
const CHANGED_EVENT = "goose:openai-realtime-voice-options-changed";
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedPreference = DEFAULT_PREFERENCE;

function stringPreference(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function enumPreference<T extends string>(
  value: unknown,
  values: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : fallback;
}

function numberPreference(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

function integerPreference(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : fallback;
}

function optionalIntegerPreference(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : null;
}

export function getRealtimeVoicePreference(): RealtimeVoicePreference {
  if (typeof window === "undefined") return DEFAULT_PREFERENCE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === cachedRaw) return cachedPreference;
    const parsed = JSON.parse(raw ?? "{}");
    cachedRaw = raw;
    cachedPreference = {
      presentationMode: enumPreference(
        parsed.presentationMode,
        ["debug", "subtle"],
        DEFAULT_PREFERENCE.presentationMode,
      ),
      model: stringPreference(parsed.model, DEFAULT_PREFERENCE.model),
      transcriptionModel: stringPreference(
        parsed.transcriptionModel,
        DEFAULT_PREFERENCE.transcriptionModel,
      ),
      voice: stringPreference(parsed.voice, DEFAULT_PREFERENCE.voice),
      speed: numberPreference(parsed.speed, 0.25, 1.5, 1),
      turnDetection: enumPreference(
        parsed.turnDetection,
        ["server_vad", "semantic_vad"],
        DEFAULT_PREFERENCE.turnDetection,
      ),
      eagerness: enumPreference(
        parsed.eagerness,
        ["low", "medium", "high", "auto"],
        DEFAULT_PREFERENCE.eagerness,
      ),
      interruptResponse:
        typeof parsed.interruptResponse === "boolean"
          ? parsed.interruptResponse
          : DEFAULT_PREFERENCE.interruptResponse,
      createResponse:
        typeof parsed.createResponse === "boolean"
          ? parsed.createResponse
          : DEFAULT_PREFERENCE.createResponse,
      vadThreshold: numberPreference(parsed.vadThreshold, 0, 1, 0.5),
      prefixPaddingMs: integerPreference(parsed.prefixPaddingMs, 0, 2_000, 300),
      silenceDurationMs: integerPreference(
        parsed.silenceDurationMs,
        100,
        3_000,
        500,
      ),
      idleTimeoutMs: optionalIntegerPreference(
        parsed.idleTimeoutMs,
        1_000,
        120_000,
      ),
      noiseReduction: enumPreference(
        parsed.noiseReduction,
        ["off", "near_field", "far_field"],
        DEFAULT_PREFERENCE.noiseReduction,
      ),
      transcriptionLanguage:
        typeof parsed.transcriptionLanguage === "string"
          ? parsed.transcriptionLanguage
          : "",
      transcriptionPrompt:
        typeof parsed.transcriptionPrompt === "string"
          ? parsed.transcriptionPrompt
          : "",
      reasoningEffort: enumPreference(
        parsed.reasoningEffort,
        ["default", "none", "low", "medium", "high"],
        DEFAULT_PREFERENCE.reasoningEffort,
      ),
      maxOutputTokens: optionalIntegerPreference(
        parsed.maxOutputTokens,
        1,
        4_096,
      ),
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
