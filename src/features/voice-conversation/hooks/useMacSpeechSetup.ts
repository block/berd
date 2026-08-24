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

export function mergeMacSpeechStatus(
  current: MacSpeechStatus | null,
  next: MacSpeechStatus,
): MacSpeechStatus {
  return current && next.revision < current.revision ? current : next;
}

export function useMacSpeechSetup(enabled = true): MacSpeechSetup {
  const [status, setStatus] = useState<MacSpeechStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    try {
      const next = await getMacSpeechStatus();
      if (generation === generationRef.current) {
        setStatus((current) => mergeMacSpeechStatus(current, next));
        setError(null);
      }
      return next;
    } catch (nextError) {
      if (generation === generationRef.current) {
        setError(String(nextError));
      }
      throw nextError;
    }
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
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    void listenToMacSpeechStatus((next) => {
      if (!active) return;
      generationRef.current += 1;
      setStatus((current) => mergeMacSpeechStatus(current, next));
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
      void refresh().catch(() => {});
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [enabled, refresh]);

  const install = useCallback(async () => {
    setError(null);
    try {
      const next = await installMacSpeechModel();
      generationRef.current += 1;
      setStatus((current) => mergeMacSpeechStatus(current, next));
    } catch (nextError) {
      const message = String(nextError);
      setStatus((current) =>
        current?.installing
          ? {
              ...current,
              installing: false,
              progress: null,
              error: message,
            }
          : current,
      );
      setError(message);
    }
  }, []);

  return { status, loading, error, refresh, install };
}
