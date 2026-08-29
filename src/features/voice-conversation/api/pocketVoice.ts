import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { shareInFlight } from "@/shared/lib/shareInFlight";
import type {
  VoiceInterruptionMode,
  VoiceInterruptionSensitivity,
} from "../lib/voiceInterruptionPreference";

export interface PocketVoice {
  id: string;
  name: string;
}

export interface PocketVoiceStatus {
  statusRevision: number;
  installed: boolean;
  pocketInstalled: boolean;
  parakeetInstalled: boolean;
  pocketSizeBytes: number | null;
  parakeetSizeBytes: number | null;
  pocketDownloadBytes: number;
  parakeetDownloadBytes: number;
  downloading: boolean;
  activeModel: VoiceModelKind | null;
  pocketAttemptId: number | null;
  parakeetAttemptId: number | null;
  pocketProgress: VoiceModelDownloadProgress | null;
  parakeetProgress: VoiceModelDownloadProgress | null;
  pocketError: string | null;
  parakeetError: string | null;
  removing: VoiceModelKind | null;
  removalQueued: boolean;
  downloadedBytes: number;
  totalBytes: number;
  error: string | null;
  selectedVoice: string;
  playbackSpeed: number;
  voices: PocketVoice[];
}

export interface PocketVoiceStreamEvent {
  streamId: string;
  state: "started" | "progress" | "completed" | "interrupted" | "failed";
  error: string | null;
  delivery?: VoiceDeliveryProgress | null;
}

export interface VoiceDeliverySegment {
  text: string;
  playedFrames: number;
  totalFrames: number;
  synthesisComplete: boolean;
}

export interface VoiceDeliveryProgress {
  sampleRate?: number;
  segments: VoiceDeliverySegment[];
}

export type VoiceModelKind = "pocket" | "parakeet";
export type VoiceModelDownloadPhase =
  | "queued"
  | "downloading"
  | "extracting"
  | "verifying"
  | "publishing"
  | "complete";

export interface VoiceModelDownloadProgress {
  attemptId: number;
  downloadedBytes: number;
  totalBytes: number;
  phase: VoiceModelDownloadPhase;
}

// Voice surfaces poll this on mount from several components at once and pass
// `{ coalesce: true }` so a mount burst issues one IPC call. A refresh that
// must observe a just-written setting (select voice / playback speed do not
// bump statusRevision, so a stale same-revision snapshot would be accepted)
// calls plainly, which never joins a pre-write read still in flight.
export const getPocketVoiceStatus = shareInFlight(() =>
  invoke<PocketVoiceStatus>("get_pocket_voice_status"),
);

export function installVoiceModel(
  model: VoiceModelKind,
): Promise<PocketVoiceStatus> {
  return invoke<PocketVoiceStatus>("install_voice_model", { model });
}

export function selectPocketVoice(voiceId: string): Promise<void> {
  return invoke("select_pocket_voice", { voiceId });
}

export function setPocketPlaybackSpeed(speed: number): Promise<void> {
  return invoke("set_pocket_playback_speed", { speed });
}

export function previewPocketVoice(voiceId: string): Promise<void> {
  return invoke("preview_pocket_voice", { voiceId });
}

export function speakPocketVoice(text: string): Promise<void> {
  return invoke("speak_pocket_voice", { text });
}

export function startPocketVoiceStream(
  sessionId: string,
  expectedRevision: number,
  speechId: number,
  streamId: string,
  interruptionMode: VoiceInterruptionMode,
  interruptionSensitivity: VoiceInterruptionSensitivity,
): Promise<boolean> {
  return invoke<boolean>("start_pocket_voice_stream", {
    sessionId,
    expectedRevision,
    speechId,
    streamId,
    interruptionMode,
    interruptionSensitivity,
  });
}

export function appendPocketVoiceStream(
  streamId: string,
  text: string,
): Promise<void> {
  return invoke("append_pocket_voice_stream", { streamId, text });
}

export function flushPocketVoiceStream(streamId: string): Promise<void> {
  return invoke("flush_pocket_voice_stream", { streamId });
}

export function finishPocketVoiceStream(streamId: string): Promise<void> {
  return invoke("finish_pocket_voice_stream", { streamId });
}

export function stopPocketVoice(): Promise<boolean> {
  return invoke<boolean>("stop_pocket_voice");
}

export function removeVoiceModel(
  model: VoiceModelKind,
): Promise<PocketVoiceStatus> {
  return invoke<PocketVoiceStatus>("remove_voice_model", { model });
}

export function listenToPocketVoiceStatus(
  onStatus: (status: PocketVoiceStatus) => void,
): Promise<UnlistenFn> {
  return listen<PocketVoiceStatus>("pocket-voice:event", (event) =>
    onStatus(event.payload),
  );
}

export function listenToPocketVoiceStream(
  onEvent: (event: PocketVoiceStreamEvent) => void,
): Promise<UnlistenFn> {
  return listen<PocketVoiceStreamEvent>("pocket-voice:stream-event", (event) =>
    onEvent(event.payload),
  );
}
