import { invoke } from "@tauri-apps/api/core";

export function resetAllVoiceBackendSettings(): Promise<void> {
  return invoke("reset_all_voice_backend_settings");
}
