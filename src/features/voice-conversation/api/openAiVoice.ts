import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { VoiceDeliveryProgress } from "./pocketVoice";
import type {
  VoiceInterruptionMode,
  VoiceInterruptionSensitivity,
} from "../lib/voiceInterruptionPreference";

export interface OpenAiVoiceStatus {
  configured: boolean;
  transcriptionModel: string;
  speechModel: string;
  speechVoice: string;
  playbackSpeed: number;
  ttsAvailable: boolean;
  unavailableReason: string | null;
}

export interface OpenAiVoiceStreamEvent {
  streamId: string;
  state: "started" | "progress" | "completed" | "interrupted" | "failed";
  error: string | null;
  delivery?: VoiceDeliveryProgress | null;
}

export function getOpenAiVoiceStatus(): Promise<OpenAiVoiceStatus> {
  return invoke<OpenAiVoiceStatus>("get_openai_voice_status");
}

export function startOpenAiVoiceStream(
  streamId: string,
  interruptionMode: VoiceInterruptionMode,
  interruptionSensitivity: VoiceInterruptionSensitivity,
): Promise<void> {
  return invoke("start_openai_voice_stream", {
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
