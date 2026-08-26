import { useEffect, useState } from "react";
import {
  getOpenAiVoiceStatus,
  type OpenAiVoiceStatus,
} from "../api/openAiVoice";

export function useOpenAiVoiceSetup(enabled = true) {
  const [status, setStatus] = useState<OpenAiVoiceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void getOpenAiVoiceStatus().then(
      (next) => {
        if (active) setStatus(next);
      },
      (cause) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      },
    );
    return () => {
      active = false;
    };
  }, [enabled]);

  return { status, error };
}
