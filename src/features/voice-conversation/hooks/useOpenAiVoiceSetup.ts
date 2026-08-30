import { useEffect, useState } from "react";
import {
  getOpenAiVoiceStatus,
  listenToOpenAiVoiceSettings,
  type OpenAiVoiceStatus,
} from "../api/openAiVoice";

export function useOpenAiVoiceSetup(enabled = true) {
  const [status, setStatus] = useState<OpenAiVoiceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let refreshGeneration = 0;
    let unsubscribe: (() => void) | null = null;
    const refresh = () => {
      const generation = ++refreshGeneration;
      void getOpenAiVoiceStatus().then(
        (next) => {
          if (active && generation === refreshGeneration) {
            setStatus(next);
            setError(null);
          }
        },
        (cause) => {
          if (active && generation === refreshGeneration) {
            setStatus(null);
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        },
      );
    };
    void listenToOpenAiVoiceSettings(refresh).then(
      (nextUnsubscribe) => {
        if (active) {
          unsubscribe = nextUnsubscribe;
          refresh();
        } else nextUnsubscribe();
      },
      () => {
        if (active) refresh();
      },
    );
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [enabled]);

  return {
    status: enabled ? status : null,
    error: enabled ? error : null,
  };
}
