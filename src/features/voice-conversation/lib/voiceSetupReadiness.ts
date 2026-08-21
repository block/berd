import type { PocketVoiceStatus } from "../api/pocketVoice";
import type { SiriVoiceStatus } from "../api/siriVoice";
import type { VoiceOutputBackend } from "./voiceOutputPreference";

export function isVoiceSetupReady(
  pocket: PocketVoiceStatus | null,
  siri: SiriVoiceStatus | null,
  backend: VoiceOutputBackend,
): boolean {
  if (!pocket?.parakeetInstalled) return false;
  if (backend === "pocket") return pocket.pocketInstalled;
  return Boolean(
    siri?.supported && siri.selectedVoice && siri.selectedVoiceInstalled,
  );
}
