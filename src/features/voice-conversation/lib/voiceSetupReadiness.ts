import {
  getPocketVoiceStatus,
  type PocketVoiceStatus,
} from "../api/pocketVoice";
import { getSiriVoiceStatus, type SiriVoiceStatus } from "../api/siriVoice";
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

export async function refreshVoiceSetupReadiness(
  backend: VoiceOutputBackend,
  siriLanguage: string,
): Promise<boolean> {
  const [pocket, siri] = await Promise.all([
    getPocketVoiceStatus(),
    backend === "siri" ? getSiriVoiceStatus(siriLanguage) : null,
  ]);
  return isVoiceSetupReady(pocket, siri, backend);
}

export interface VoiceSetupSelection {
  backend: VoiceOutputBackend;
  siriLanguage: string;
  revision: number;
}

export async function refreshStableVoiceSetupReadiness(
  getSelection: () => VoiceSetupSelection,
): Promise<boolean> {
  for (;;) {
    const selection = getSelection();
    const ready = await refreshVoiceSetupReadiness(
      selection.backend,
      selection.siriLanguage,
    );
    const current = getSelection();
    if (
      current.backend === selection.backend &&
      current.siriLanguage === selection.siriLanguage &&
      current.revision === selection.revision
    ) {
      return ready;
    }
  }
}
