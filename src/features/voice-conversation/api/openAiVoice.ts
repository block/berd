import { invoke } from "@tauri-apps/api/core";
import { shareInFlight } from "@/shared/lib/shareInFlight";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { VoiceDeliveryProgress } from "./pocketVoice";
import type {
  VoiceInterruptionMode,
  VoiceInterruptionSensitivity,
} from "../lib/voiceInterruptionPreference";

export interface OpenAiVoiceStatus {
  sttConfigured: boolean;
  ttsConfigured: boolean;
  sttConfigurationSource: "default" | "environment";
  ttsConfigurationSource: "default" | "environment";
  sttUnavailableReason: string | null;
  ttsUnavailableReason: string | null;
  transcriptionModel: string;
  speechModel: string;
  speechVoice: string;
  playbackSpeed: number;
  ttsAvailable: boolean;
  unavailableReason: "missingApiKey" | "unsupportedPlatform" | null;
}

export interface OpenAiVoiceStreamEvent {
  streamId: string;
  state: "started" | "progress" | "completed" | "interrupted" | "failed";
  error: string | null;
  delivery?: VoiceDeliveryProgress | null;
}

export const getOpenAiVoiceStatus = shareInFlight(
  (): Promise<OpenAiVoiceStatus> => invoke("get_openai_voice_status"),
);

export function setOpenAiTtsApiKey(apiKey: string): Promise<void> {
  return invoke("set_openai_tts_api_key", { apiKey });
}

export function setOpenAiSttApiKey(apiKey: string): Promise<void> {
  return invoke("set_openai_stt_api_key", { apiKey });
}

export function clearOpenAiSttApiKey(): Promise<void> {
  return invoke("clear_openai_stt_api_key");
}

export function clearOpenAiTtsApiKey(): Promise<void> {
  return invoke("clear_openai_tts_api_key");
}

export function listenToOpenAiVoiceSettings(
  onChanged: () => void,
): Promise<UnlistenFn> {
  return listen("openai-voice:settings-changed", onChanged);
}

export function startOpenAiVoiceStream(
  sessionId: string,
  expectedRevision: number,
  speechId: number,
  streamId: string,
  interruptionMode: VoiceInterruptionMode,
  interruptionSensitivity: VoiceInterruptionSensitivity,
): Promise<boolean> {
  return invoke<boolean>("start_openai_voice_stream", {
    sessionId,
    expectedRevision,
    speechId,
    streamId,
    interruptionMode,
    interruptionSensitivity,
  });
}

export function appendOpenAiVoiceStream(
  streamId: string,
  text: string,
): Promise<void> {
  return invoke("append_openai_voice_stream", { streamId, text });
}

export function flushOpenAiVoiceStream(streamId: string): Promise<void> {
  return invoke("flush_openai_voice_stream", { streamId });
}

export function finishOpenAiVoiceStream(streamId: string): Promise<void> {
  return invoke("finish_openai_voice_stream", { streamId });
}

export function stopOpenAiVoice(): Promise<boolean> {
  return invoke<boolean>("stop_openai_voice");
}

export function setOpenAiPlaybackSpeed(speed: number): Promise<void> {
  return invoke("set_openai_playback_speed", { speed });
}

export function listenToOpenAiVoiceStream(
  onEvent: (event: OpenAiVoiceStreamEvent) => void,
): Promise<UnlistenFn> {
  return listen<OpenAiVoiceStreamEvent>("openai-voice:stream-event", (event) =>
    onEvent(event.payload),
  );
}
