import type { PocketVoiceStatus } from "../api/pocketVoice";
import type { SiriVoiceStatus } from "../api/siriVoice";
import type { MacSpeechStatus } from "../api/macSpeech";
import type { VoiceInputBackend } from "./voiceInputPreference";
import type { VoiceOutputBackend } from "./voiceOutputPreference";

export function isVoiceSetupReady(
  pocket: PocketVoiceStatus | null,
  macSpeech: MacSpeechStatus | null,
  siri: SiriVoiceStatus | null,
  inputBackend: VoiceInputBackend | null,
  outputBackend: VoiceOutputBackend,
): boolean {
  if (inputBackend === null) return false;
  const inputReady =
    inputBackend === "macos"
      ? Boolean(
          macSpeech?.supported &&
            macSpeech.localeSupported &&
            macSpeech.modelInstalled,
        )
      : Boolean(pocket?.parakeetInstalled);
  if (!inputReady) return false;
  if (outputBackend === "pocket") return Boolean(pocket?.pocketInstalled);
  return Boolean(
    siri?.supported && siri.selectedVoice && siri.selectedVoiceInstalled,
  );
}
