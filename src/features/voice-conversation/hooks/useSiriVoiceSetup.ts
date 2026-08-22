import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  downloadSiriVoice,
  getSiriVoiceStatus,
  previewSiriVoice,
  selectSiriVoice,
  setSiriPlaybackSpeed,
  type SiriVoice,
  type SiriVoiceSelection,
  type SiriVoiceStatus,
} from "../api/siriVoice";

function canonicalLocale(locale: string): string {
  try {
    return new Intl.Locale(locale.replaceAll("_", "-")).toString();
  } catch {
    return locale.replaceAll("_", "-") || "en-US";
  }
}

function primaryLanguage(locale: string): string {
  try {
    return new Intl.Locale(canonicalLocale(locale)).language;
  } catch {
    return canonicalLocale(locale).split("-", 1)[0]?.toLowerCase() || "en";
  }
}

function availableLocales(locales: string[]): string[] {
  return Array.from(new Set(locales.map(canonicalLocale))).sort();
}

function chooseAvailableLocale(preferred: string, available: string[]): string {
  const exact = canonicalLocale(preferred);
  if (available.includes(exact)) return exact;
  const preferredLanguage = primaryLanguage(exact);
  return (
    available.find(
      (candidate) => primaryLanguage(candidate) === preferredLanguage,
    ) ??
    available[0] ??
    exact
  );
}

function initialSelectedVoiceLocale(
  current: string,
  available: string[],
  selectedVoice: SiriVoiceSelection,
): string {
  const selectedLocale = canonicalLocale(selectedVoice.language);
  return available.includes(selectedLocale) ? selectedLocale : current;
}

function voiceKey(voice: SiriVoiceSelection): string {
  return `${voice.name.toLowerCase()}|${voice.language.toLowerCase()}`;
}

const SIRI_VOICE_SETTINGS_CHANGED = "berd:siri-voice-settings-changed";

export interface SiriVoiceSetup {
  status: SiriVoiceStatus | null;
  language: string;
  languages: string[];
  loading: boolean;
  error: string | null;
  statusError: string | null;
  downloadingVoiceKey: string | null;
  previewingVoiceKey: string | null;
  setLanguage: (language: string) => void;
  setPlaybackSpeed: (speed: number) => Promise<void>;
  downloadVoice: (voice: SiriVoice) => Promise<void>;
  previewVoice: (voice: SiriVoice) => Promise<void>;
  selectVoice: (voice: SiriVoice) => Promise<void>;
}

export function useSiriVoiceSetup(enabled = true): SiriVoiceSetup {
  const [status, setStatus] = useState<SiriVoiceStatus | null>(null);
  const [language, setLanguage] = useState(() =>
    canonicalLocale(
      typeof navigator === "undefined" ? "en-US" : navigator.language,
    ),
  );
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [downloadingVoiceKey, setDownloadingVoiceKey] = useState<string | null>(
    null,
  );
  const [previewingVoiceKey, setPreviewingVoiceKey] = useState<string | null>(
    null,
  );
  const languageRef = useRef(language);
  const statusRequestGenerationRef = useRef(0);
  const initialSelectedLocaleAppliedRef = useRef(false);
  const languageSelectedByUserRef = useRef(false);
  languageRef.current = language;

  const selectLanguage = useCallback((nextLanguage: string) => {
    languageSelectedByUserRef.current = true;
    setLanguage(canonicalLocale(nextLanguage));
  }, []);

  const refresh = useCallback(async (prefix: string) => {
    const generation = ++statusRequestGenerationRef.current;
    try {
      const next = await getSiriVoiceStatus(prefix, { coalesce: true });
      if (
        statusRequestGenerationRef.current === generation &&
        canonicalLocale(languageRef.current) === canonicalLocale(prefix)
      ) {
        setStatus(next);
        setError(null);
        setStatusError(null);
      }
      return next;
    } catch (nextError) {
      if (
        statusRequestGenerationRef.current === generation &&
        canonicalLocale(languageRef.current) === canonicalLocale(prefix)
      ) {
        setError(String(nextError));
        setStatusError(String(nextError));
      }
      return null;
    }
  }, []);

  useEffect(() => {
    if (!enabled || !window.__TAURI_INTERNALS__) {
      setStatus(null);
      setLoading(false);
      return;
    }
    let active = true;
    const generation = ++statusRequestGenerationRef.current;
    setLoading(true);
    setError(null);
    setStatusError(null);
    void getSiriVoiceStatus(language, { coalesce: true })
      .then((next) => {
        if (active && statusRequestGenerationRef.current === generation) {
          setStatus(next);
        }
      })
      .catch((nextError) => {
        if (active && statusRequestGenerationRef.current === generation) {
          setError(String(nextError));
          setStatusError(String(nextError));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      statusRequestGenerationRef.current += 1;
    };
  }, [enabled, language]);

  useEffect(() => {
    if (!enabled || !window.__TAURI_INTERNALS__) return;
    const handleSettingsChanged = () => {
      void refresh(language);
    };
    window.addEventListener(SIRI_VOICE_SETTINGS_CHANGED, handleSettingsChanged);
    return () => {
      window.removeEventListener(
        SIRI_VOICE_SETTINGS_CHANGED,
        handleSettingsChanged,
      );
    };
  }, [enabled, language, refresh]);

  const languages = useMemo(
    () => availableLocales(status?.availableLanguages ?? []),
    [status?.availableLanguages],
  );

  useEffect(() => {
    if (languages.length === 0 || languages.includes(language)) return;
    setLanguage(chooseAvailableLocale(language, languages));
  }, [language, languages]);

  useEffect(() => {
    if (
      initialSelectedLocaleAppliedRef.current ||
      languageSelectedByUserRef.current ||
      !status?.selectedVoice
    ) {
      return;
    }
    initialSelectedLocaleAppliedRef.current = true;
    const selectedLocale = initialSelectedVoiceLocale(
      language,
      languages,
      status.selectedVoice,
    );
    if (selectedLocale !== language) {
      setLanguage(selectedLocale);
    }
  }, [language, languages, status?.selectedVoice]);

  useEffect(() => {
    if (!enabled || !window.__TAURI_INTERNALS__) return;
    const handleFocus = () => {
      void refresh(language);
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [enabled, language, refresh]);

  const downloadVoice = useCallback(
    async (voice: SiriVoice) => {
      const selection = { name: voice.name, language: voice.language };
      setError(null);
      setDownloadingVoiceKey(voiceKey(selection));
      try {
        await downloadSiriVoice(selection);
        window.dispatchEvent(new Event(SIRI_VOICE_SETTINGS_CHANGED));
        await refresh(language);
      } catch (nextError) {
        setError(String(nextError));
      } finally {
        setDownloadingVoiceKey(null);
      }
    },
    [language, refresh],
  );

  const previewVoice = useCallback(async (voice: SiriVoice) => {
    const selection = { name: voice.name, language: voice.language };
    setError(null);
    setPreviewingVoiceKey(voiceKey(selection));
    try {
      await previewSiriVoice(selection);
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      setPreviewingVoiceKey(null);
    }
  }, []);

  const selectVoice = useCallback(
    async (voice: SiriVoice) => {
      setError(null);
      try {
        await selectSiriVoice({ name: voice.name, language: voice.language });
        window.dispatchEvent(new Event(SIRI_VOICE_SETTINGS_CHANGED));
        await refresh(language);
      } catch (nextError) {
        setError(String(nextError));
      }
    },
    [language, refresh],
  );

  const setPlaybackSpeed = useCallback(
    async (speed: number) => {
      setError(null);
      try {
        await setSiriPlaybackSpeed(speed);
        window.dispatchEvent(new Event(SIRI_VOICE_SETTINGS_CHANGED));
        await refresh(language);
      } catch (nextError) {
        setError(String(nextError));
      }
    },
    [language, refresh],
  );

  return {
    status,
    language,
    languages,
    loading,
    error,
    statusError,
    downloadingVoiceKey,
    previewingVoiceKey,
    setLanguage: selectLanguage,
    setPlaybackSpeed,
    downloadVoice,
    previewVoice,
    selectVoice,
  };
}

export {
  availableLocales,
  canonicalLocale,
  chooseAvailableLocale,
  initialSelectedVoiceLocale,
  primaryLanguage,
  voiceKey,
};
