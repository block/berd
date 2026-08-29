import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { VoiceDeliveryProgress } from "./pocketVoice";
import type {
  VoiceInterruptionMode,
  VoiceInterruptionSensitivity,
} from "../lib/voiceInterruptionPreference";

export interface SiriVoice {
  name: string;
  language: string;
  sizeBytes: number;
  installed: boolean;
}

export interface SiriVoiceSelection {
  name: string;
  language: string;
}

export interface SiriVoiceStatus {
  supported: boolean;
  availableLanguages: string[];
  selectedVoice: SiriVoiceSelection | null;
  selectedVoiceInstalled: boolean;
  playbackSpeed: number;
  voices: SiriVoice[];
}

const statusRequests = new Map<string, Promise<SiriVoiceStatus>>();

export function getSiriVoiceStatus(
  languagePrefix: string,
  options?: { coalesce?: boolean },
): Promise<SiriVoiceStatus> {
  const key = languagePrefix.replaceAll("_", "-").toLowerCase();
  const current = statusRequests.get(key);
  if (options?.coalesce && current) return current;
  const request = invoke<SiriVoiceStatus>("get_siri_voice_status", {
    languagePrefix,
  }).finally(() => {
    if (statusRequests.get(key) === request) statusRequests.delete(key);
  });
  statusRequests.set(key, request);
  return request;
}

export function downloadSiriVoice(voice: SiriVoiceSelection): Promise<void> {
  return invoke("download_siri_voice", { voice });
}

export function selectSiriVoice(voice: SiriVoiceSelection): Promise<void> {
  return invoke("select_siri_voice", { voice });
}

export function previewSiriVoice(voice: SiriVoiceSelection): Promise<void> {
  return invoke("preview_siri_voice", { voice });
}

export function setSiriPlaybackSpeed(speed: number): Promise<void> {
  return invoke("set_siri_playback_speed", { speed });
}

export interface SiriVoiceStreamEvent {
  streamId: string;
  state: "started" | "progress" | "completed" | "interrupted" | "failed";
  error: string | null;
  delivery?: VoiceDeliveryProgress | null;
}

export function startSiriVoiceStream(
  sessionId: string,
  expectedRevision: number,
  speechId: number,
  streamId: string,
  voice: SiriVoiceSelection,
  interruptionMode: VoiceInterruptionMode,
  interruptionSensitivity: VoiceInterruptionSensitivity,
): Promise<boolean> {
  return invoke<boolean>("start_siri_voice_stream", {
    sessionId,
    expectedRevision,
    speechId,
    streamId,
    voice,
    interruptionMode,
    interruptionSensitivity,
  });
}

export function appendSiriVoiceStream(
  streamId: string,
  text: string,
): Promise<void> {
  return invoke("append_siri_voice_stream", { streamId, text });
}

export function flushSiriVoiceStream(streamId: string): Promise<void> {
  return invoke("flush_siri_voice_stream", { streamId });
}

export function finishSiriVoiceStream(streamId: string): Promise<void> {
  return invoke("finish_siri_voice_stream", { streamId });
}

export function stopSiriVoice(): Promise<boolean> {
  return invoke<boolean>("stop_siri_voice");
}

export function listenToSiriVoiceStream(
  onEvent: (event: SiriVoiceStreamEvent) => void,
): Promise<UnlistenFn> {
  return listen<SiriVoiceStreamEvent>("siri-voice:stream-event", (event) =>
    onEvent(event.payload),
  );
}
