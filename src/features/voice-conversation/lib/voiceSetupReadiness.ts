import type { PocketVoiceStatus } from "../api/pocketVoice";
import type { SiriVoiceStatus } from "../api/siriVoice";
import type { MacSpeechStatus } from "../api/macSpeech";
import type { VoiceInputBackend } from "./voiceInputPreference";
import type { OpenAiVoiceStatus } from "../api/openAiVoice";
import type { VoiceOutputBackend } from "./voiceOutputPreference";

export function isVoiceSetupReady(
  pocket: PocketVoiceStatus | null,
  macSpeech: MacSpeechStatus | null,
  siri: SiriVoiceStatus | null,
  inputBackend: VoiceInputBackend | null,
  outputBackend: VoiceOutputBackend,
  openAi: OpenAiVoiceStatus | null = null,
): boolean {
  if (inputBackend === null) return false;
  const inputReady =
    inputBackend === "openai"
      ? Boolean(openAi?.sttConfigured)
      : inputBackend === "macos"
        ? Boolean(
            macSpeech?.supported &&
              macSpeech.localeSupported &&
              macSpeech.modelInstalled,
          )
        : Boolean(pocket?.parakeetInstalled);
  if (!inputReady) return false;
  if (outputBackend === "openai")
    return Boolean(openAi?.ttsConfigured && openAi.ttsAvailable);
  if (outputBackend === "pocket") return Boolean(pocket?.pocketInstalled);
  return Boolean(
    siri?.supported && siri.selectedVoice && siri.selectedVoiceInstalled,
  );
}
