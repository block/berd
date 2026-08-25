import { useCallback, useEffect, useRef, useState } from "react";
import {
  getMicrophonePermissionStatus,
  openMicrophonePrivacySettings,
  type MicrophonePermissionStatus,
} from "../api/microphonePermission";

export interface MicrophonePermission {
  status: MicrophonePermissionStatus | null;
  openSettingsError: boolean;
  openSettings: () => Promise<void>;
}

export function useMicrophonePermission(enabled = true): MicrophonePermission {
  const [status, setStatus] = useState<MicrophonePermissionStatus | null>(null);
  const [openSettingsError, setOpenSettingsError] = useState(false);
  const refreshId = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++refreshId.current;
    try {
      const next = await getMicrophonePermissionStatus();
      if (id !== refreshId.current) return;
      setStatus(next);
    } catch (cause) {
      if (id !== refreshId.current) return;
      console.error("Failed to read microphone permission", cause);
    }
  }, []);

  useEffect(() => {
    if (!enabled || !window.__TAURI_INTERNALS__) {
      refreshId.current += 1;
      setStatus(null);
      setOpenSettingsError(false);
      return;
    }
    void refresh();
    const handleFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", handleFocus);
    return () => {
      refreshId.current += 1;
      window.removeEventListener("focus", handleFocus);
    };
  }, [enabled, refresh]);

  const openSettings = useCallback(async () => {
    setOpenSettingsError(false);
    try {
      await openMicrophonePrivacySettings();
    } catch (cause) {
      console.error("Failed to open microphone settings", cause);
      setOpenSettingsError(true);
    }
  }, []);

  return { status, openSettingsError, openSettings };
}
