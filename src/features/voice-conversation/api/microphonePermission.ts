import { invoke } from "@tauri-apps/api/core";

export type MicrophonePermissionStatus =
  | "notDetermined"
  | "denied"
  | "authorized"
  | "unknown";

export function getMicrophonePermissionStatus(): Promise<MicrophonePermissionStatus> {
  return invoke<MicrophonePermissionStatus>("get_microphone_permission_status");
}

export function openMicrophonePrivacySettings(): Promise<void> {
  return invoke<void>("open_microphone_privacy_settings");
}
