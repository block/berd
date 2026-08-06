import { useEffect, useState } from "react";

import {
  getSessionWindowSupport,
  type SessionWindowSupport,
} from "@/features/chat/lib/sessionWindowCommands";

const UNSUPPORTED: SessionWindowSupport = {
  supported: false,
  reason: "session windows are unavailable in this environment",
};

export function useSessionWindowSupport() {
  const [support, setSupport] = useState<SessionWindowSupport>(() =>
    window.__TAURI_INTERNALS__ ? { supported: false } : UNSUPPORTED,
  );

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) {
      setSupport(UNSUPPORTED);
      return;
    }

    let cancelled = false;
    // Mount probe: every simultaneously mounted row shares one IPC call.
    void getSessionWindowSupport({ coalesce: true })
      .then((nextSupport) => {
        if (!cancelled) {
          setSupport(nextSupport);
        }
      })
      .catch((error) => {
        console.error("Failed to get session window support:", error);
        if (!cancelled) {
          setSupport(UNSUPPORTED);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return support;
}
