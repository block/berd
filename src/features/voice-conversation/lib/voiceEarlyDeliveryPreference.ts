import { useCallback } from "react";
import { VOICE_CONVERSATION_EXPERIMENT_ID as id } from "@/features/experiments/experimentDefinitions";
import {
  EXPERIMENT_PREFERENCES_STORAGE_KEY,
  getExperiment,
  setExperimentConfigValue,
  subscribeToExperimentChanges,
  useExperiment,
} from "@/features/experiments/experimentPreferences";

export interface VoiceEarlyDeliveryPreference {
  enabled: boolean;
}

// Compatibility for the briefly published standalone switch. Registry choices win.
function migrateLegacyOff() {
  if (typeof window === "undefined") return;
  const legacyKey = "goose:voice-early-delivery-preference";
  try {
    const legacy = window.localStorage.getItem(legacyKey);
    if (!legacy) return;
    const stored = JSON.parse(
      window.localStorage.getItem(EXPERIMENT_PREFERENCES_STORAGE_KEY) ?? "{}",
    );
    if (
      stored.experiments?.[id]?.config?.earlyDelivery === undefined &&
      JSON.parse(legacy)?.enabled === false &&
      !setExperimentConfigValue(id, "earlyDelivery", false)
    )
      return;
    window.localStorage.removeItem(legacyKey);
  } catch {
    // Leave failed migrations intact for the next read.
  }
}

export function getDefaultVoiceEarlyDeliveryPreference(): VoiceEarlyDeliveryPreference {
  return { enabled: true };
}

export function getVoiceEarlyDeliveryPreference(): VoiceEarlyDeliveryPreference {
  migrateLegacyOff();
  const experiment = getExperiment(id);
  return {
    enabled: !!experiment?.enabled && experiment.config.earlyDelivery === true,
  };
}

export const subscribeToVoiceEarlyDeliveryPreference =
  subscribeToExperimentChanges;

export function setVoiceEarlyDeliveryPreference(
  preference: VoiceEarlyDeliveryPreference,
): boolean {
  migrateLegacyOff();
  return setExperimentConfigValue(id, "earlyDelivery", preference.enabled);
}

export function useVoiceEarlyDeliveryPreference() {
  migrateLegacyOff();
  const experiment = useExperiment(id);
  const setEnabled = useCallback(
    (enabled: boolean) => setVoiceEarlyDeliveryPreference({ enabled }),
    [],
  );
  return {
    enabled: !!experiment?.enabled && experiment.config.earlyDelivery === true,
    setEnabled,
  };
}
