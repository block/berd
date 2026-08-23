import {
  getPocketVoiceStatus,
  type PocketVoiceStatus,
} from "../api/pocketVoice";
import { getSiriVoiceStatus, type SiriVoiceStatus } from "../api/siriVoice";
import { getMacSpeechStatus, type MacSpeechStatus } from "../api/macSpeech";
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

export async function refreshVoiceSetupReadiness(
  inputBackend: VoiceInputBackend | null,
  outputBackend: VoiceOutputBackend,
  siriLanguage: string,
): Promise<boolean> {
  if (inputBackend === null) return false;
  const [pocket, macSpeech, siri] = await Promise.all([
    getPocketVoiceStatus(),
    inputBackend === "macos" ? getMacSpeechStatus() : null,
    outputBackend === "siri" ? getSiriVoiceStatus(siriLanguage) : null,
  ]);
  return isVoiceSetupReady(
    pocket,
    macSpeech,
    siri,
    inputBackend,
    outputBackend,
  );
}

export interface VoiceSetupSelection {
  inputBackend: VoiceInputBackend | null;
  outputBackend: VoiceOutputBackend;
  siriLanguage: string;
  revision: number;
}

export async function refreshStableVoiceSetupReadiness(
  getSelection: () => VoiceSetupSelection,
): Promise<boolean> {
  for (;;) {
    const selection = getSelection();
    const ready = await refreshVoiceSetupReadiness(
      selection.inputBackend,
      selection.outputBackend,
      selection.siriLanguage,
    );
    const current = getSelection();
    if (
      current.inputBackend === selection.inputBackend &&
      current.outputBackend === selection.outputBackend &&
      current.siriLanguage === selection.siriLanguage &&
      current.revision === selection.revision
    ) {
      return ready;
    }
  }
}
