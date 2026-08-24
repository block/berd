import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface MacSpeechStatus {
  supported: boolean;
  unavailableReason: string | null;
  locale: string | null;
  localeSupported: boolean;
  modelInstalled: boolean;
  installing: boolean;
  progress: number | null;
  error: string | null;
  revision: number;
}

export const MAC_SPEECH_STATUS_EVENT = "mac-speech:status";

export function getMacSpeechStatus(): Promise<MacSpeechStatus> {
  return invoke<MacSpeechStatus>("get_mac_speech_status");
}

export function installMacSpeechModel(): Promise<MacSpeechStatus> {
  return invoke<MacSpeechStatus>("install_mac_speech_model");
}

export function listenToMacSpeechStatus(
  onStatus: (status: MacSpeechStatus) => void,
): Promise<UnlistenFn> {
  return listen<MacSpeechStatus>(MAC_SPEECH_STATUS_EVENT, (event) => {
    onStatus(event.payload);
  });
}
