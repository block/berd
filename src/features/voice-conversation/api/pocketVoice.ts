import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { shareInFlight } from "@/shared/lib/shareInFlight";

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

// Voice surfaces poll this on mount from several components at once; share
// the in-flight request so a mount burst issues one IPC call. A refresh that
// must observe a just-written setting (select voice / playback speed do not
// bump statusRevision, so a stale same-revision snapshot would be accepted)
// passes `{ fresh: true }` to bypass any pre-write read still in flight.
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
