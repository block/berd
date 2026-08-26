import { useEffect, useState } from "react";
import {
  getOpenAiVoiceStatus,
  type OpenAiVoiceStatus,
} from "../api/openAiVoice";
import { onProviderConfigChanged } from "@/features/providers/api/credentials";

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
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        },
      );
    };
    void onProviderConfigChanged((providerId) => {
      if (providerId === "openai") refresh();
    }).then((nextUnsubscribe) => {
      if (active) {
        unsubscribe = nextUnsubscribe;
        refresh();
      } else nextUnsubscribe();
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [enabled]);

  return { status, error };
}
