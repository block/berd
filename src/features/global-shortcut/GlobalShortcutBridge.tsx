import { useCallback, useEffect, useRef } from "react";

import { useGlobalShortcutPreference } from "@/features/global-shortcut/globalShortcutPreference";
import { useShortcutBindings } from "@/features/shortcuts/lib/shortcutRegistry";
import {
  launchGlobalShortcutHandler,
  stopGlobalShortcutHandler,
} from "@/shared/api/globalShortcut";
import { getPlatform } from "@/shared/lib/platform";

export function GlobalShortcutBridge() {
  const isMac = getPlatform() === "mac";
  const { enabled } = useGlobalShortcutPreference();
  const bindings = useShortcutBindings("navigation.globalShortcut");
  const shortcut = bindings[0]?.shortcut ?? null;
  const activeShortcutRef = useRef<string | null>(null);
  const launchGenerationRef = useRef(0);
  const operationQueueRef = useRef<Promise<void>>(Promise.resolve());

  const enqueueOperation = useCallback(
    (operation: () => Promise<void>, onError: (error: unknown) => void) => {
      operationQueueRef.current = operationQueueRef.current
        .catch(() => undefined)
        .then(operation)
        .catch(onError);
    },
    [],
  );

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) {
      return;
    }

    if (!isMac || !enabled || !shortcut) {
      if (activeShortcutRef.current !== null) {
        activeShortcutRef.current = null;
        launchGenerationRef.current += 1;
        enqueueOperation(stopGlobalShortcutHandler, (error) => {
          console.error("Failed to stop global shortcut handler:", error);
        });
      }
      return;
    }

    if (activeShortcutRef.current === shortcut) {
      return;
    }

    activeShortcutRef.current = shortcut;
    const launchGeneration = launchGenerationRef.current + 1;
    launchGenerationRef.current = launchGeneration;
    enqueueOperation(
      () => launchGlobalShortcutHandler(shortcut, { initiallyHidden: true }),
      (error) => {
        console.error("Failed to launch global shortcut handler:", error);
        if (
          launchGenerationRef.current === launchGeneration &&
          activeShortcutRef.current === shortcut
        ) {
          activeShortcutRef.current = null;
        }
      },
    );
  }, [enabled, enqueueOperation, isMac, shortcut]);

  useEffect(() => {
    return () => {
      if (!window.__TAURI_INTERNALS__ || activeShortcutRef.current === null) {
        return;
      }
      activeShortcutRef.current = null;
      launchGenerationRef.current += 1;
      enqueueOperation(stopGlobalShortcutHandler, (error) => {
        console.error("Failed to stop global shortcut handler:", error);
      });
    };
  }, [enqueueOperation]);

  return null;
}
