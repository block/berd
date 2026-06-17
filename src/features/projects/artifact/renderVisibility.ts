import { useSyncExternalStore } from "react";
import type { Window as TauriWindow } from "@tauri-apps/api/window";

export function isDocumentVisible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
}

async function isTauriWindowVisible(appWindow: TauriWindow): Promise<boolean> {
  const [isVisible, isMinimized] = await Promise.all([
    appWindow.isVisible().catch(() => true),
    appWindow.isMinimized().catch(() => false),
  ]);

  return isVisible && !isMinimized;
}

export async function resolveRenderWindowVisible(
  appWindow: TauriWindow | null,
): Promise<boolean> {
  if (!isDocumentVisible()) {
    return false;
  }

  if (!appWindow) {
    return true;
  }

  return isTauriWindowVisible(appWindow);
}

type VisibilityListener = () => void;
type Unlisten = () => void;

let currentVisibility = isDocumentVisible();
let appWindow: TauriWindow | null = null;
let stopTracking: Unlisten | null = null;
let requestSequence = 0;
const listeners = new Set<VisibilityListener>();

function getRenderWindowVisibleSnapshot(): boolean {
  return currentVisibility;
}

function setRenderWindowVisibleSnapshot(nextVisibility: boolean): void {
  if (currentVisibility === nextVisibility) {
    return;
  }

  currentVisibility = nextVisibility;
  for (const listener of listeners) {
    listener();
  }
}

function syncRenderWindowVisibility(): void {
  const requestId = ++requestSequence;
  const requestWindow = appWindow;

  void resolveRenderWindowVisible(requestWindow)
    .then((nextVisibility) => {
      if (requestId !== requestSequence) {
        return;
      }

      setRenderWindowVisibleSnapshot(nextVisibility && isDocumentVisible());
    })
    .catch(() => {
      if (requestId !== requestSequence) {
        return;
      }

      setRenderWindowVisibleSnapshot(isDocumentVisible());
    });
}

function startTrackingRenderWindowVisibility(): void {
  if (stopTracking) {
    return;
  }

  let stopped = false;
  let unlistenFocus: Unlisten | undefined;
  let unlistenResize: Unlisten | undefined;
  const syncVisibility = () => syncRenderWindowVisibility();

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", syncVisibility);
  }

  if (typeof window !== "undefined") {
    window.addEventListener("focus", syncVisibility);
    window.addEventListener("blur", syncVisibility);

    if (window.__TAURI_INTERNALS__) {
      void import("@tauri-apps/api/window")
        .then(async ({ getCurrentWindow }) => {
          if (stopped) {
            return;
          }

          appWindow = getCurrentWindow();
          const [focusUnlisten, resizeUnlisten] = await Promise.all([
            appWindow.onFocusChanged(syncVisibility),
            appWindow.onResized(syncVisibility),
          ]);

          if (stopped) {
            focusUnlisten();
            resizeUnlisten();
            return;
          }

          unlistenFocus = focusUnlisten;
          unlistenResize = resizeUnlisten;
          syncVisibility();
        })
        .catch(() => {
          if (!stopped) {
            syncVisibility();
          }
        });
    }
  }

  syncVisibility();

  stopTracking = () => {
    stopped = true;
    requestSequence += 1;
    appWindow = null;

    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", syncVisibility);
    }

    if (typeof window !== "undefined") {
      window.removeEventListener("focus", syncVisibility);
      window.removeEventListener("blur", syncVisibility);
    }

    unlistenFocus?.();
    unlistenResize?.();
    stopTracking = null;
  };
}

function subscribeRenderWindowVisible(listener: VisibilityListener): Unlisten {
  listeners.add(listener);
  startTrackingRenderWindowVisibility();

  return () => {
    listeners.delete(listener);

    if (listeners.size === 0) {
      stopTracking?.();
    }
  };
}

export function useRenderWindowVisible(): boolean {
  return useSyncExternalStore(
    subscribeRenderWindowVisible,
    getRenderWindowVisibleSnapshot,
    isDocumentVisible,
  );
}
