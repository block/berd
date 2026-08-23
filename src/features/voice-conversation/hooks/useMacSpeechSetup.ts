import { useCallback, useEffect, useRef, useState } from "react";
import {
  getMacSpeechStatus,
  installMacSpeechModel,
  listenToMacSpeechStatus,
  type MacSpeechStatus,
} from "../api/macSpeech";

export interface MacSpeechSetup {
  status: MacSpeechStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<MacSpeechStatus>;
  install: () => Promise<void>;
}

export function useMacSpeechSetup(enabled = true): MacSpeechSetup {
  const [status, setStatus] = useState<MacSpeechStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    const next = await getMacSpeechStatus();
    if (generation === generationRef.current) {
      setStatus(next);
      setError(null);
    }
    return next;
  }, []);

  useEffect(() => {
    if (!enabled || !window.__TAURI_INTERNALS__) {
      setLoading(false);
      return;
    }
    let active = true;
    let unlisten: (() => void) | undefined;
    setLoading(true);
    void refresh()
      .catch((nextError) => {
        if (active) setError(String(nextError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    void listenToMacSpeechStatus((next) => {
      if (!active) return;
      generationRef.current += 1;
      setStatus(next);
      setError(null);
    }).then((nextUnlisten) => {
      if (!active) nextUnlisten();
      else unlisten = nextUnlisten;
    });
    return () => {
      active = false;
      generationRef.current += 1;
      unlisten?.();
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled || !window.__TAURI_INTERNALS__) return;
    const handleFocus = () => {
      void refresh().catch((nextError) => setError(String(nextError)));
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [enabled, refresh]);

  const install = useCallback(async () => {
    setError(null);
    try {
      const next = await installMacSpeechModel();
      generationRef.current += 1;
      setStatus(next);
    } catch (nextError) {
      setError(String(nextError));
    }
  }, []);

  return { status, loading, error, refresh, install };
}
