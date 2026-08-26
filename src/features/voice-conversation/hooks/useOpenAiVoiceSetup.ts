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
    const refresh = () => {
      void getOpenAiVoiceStatus().then(
        (next) => {
          if (active) {
            setStatus(next);
            setError(null);
          }
        },
        (cause) => {
          if (active) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        },
      );
    };
    refresh();
    const unsubscribe = onProviderConfigChanged((providerId) => {
      if (providerId === "openai") refresh();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [enabled]);

  return { status, error };
}
