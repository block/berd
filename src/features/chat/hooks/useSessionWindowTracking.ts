import { useEffect } from "react";

import { listSessionWindows } from "@/features/chat/lib/sessionWindowCommands";
import {
  useSessionWindowStore,
  type SessionWindowEntry,
} from "@/features/chat/stores/sessionWindowStore";

interface UseSessionWindowTrackingOptions {
  enabled?: boolean;
}

export function useSessionWindowTracking({
  enabled = true,
}: UseSessionWindowTrackingOptions = {}) {
  useEffect(() => {
    if (!enabled || !window.__TAURI_INTERNALS__) {
      useSessionWindowStore.getState().setSnapshot([]);
      return;
    }

    let didCancel = false;
    let unlisten: (() => void) | undefined;

    async function setupSessionWindowTracking() {
      const { listen } = await import("@tauri-apps/api/event");
      const setSnapshot = (entries: SessionWindowEntry[]) => {
        useSessionWindowStore.getState().setSnapshot(entries);
      };

      listSessionWindows()
        .then((entries) => {
          if (!didCancel) {
            setSnapshot(entries);
          }
        })
        .catch((error) => {
          console.error("Failed to list session windows:", error);
        });

      unlisten = await listen<SessionWindowEntry[]>(
        "session-windows-changed",
        (event) => {
          setSnapshot(event.payload);
        },
      );

      if (didCancel) {
        unlisten();
      }
    }

    void setupSessionWindowTracking().catch((error) => {
      console.error("Failed to subscribe to session window changes:", error);
    });

    return () => {
      didCancel = true;
      unlisten?.();
    };
  }, [enabled]);
}
