import { useEffect } from "react";

import { AppShell } from "@/app/AppShell";
import { TopBarActionsProvider } from "@/app/contexts/TopBarActionsContext";
import { useScrollFade } from "@/shared/hooks/useScrollFade";
import { useZoom } from "@/shared/hooks/useZoom";
import { Toaster } from "@/shared/ui/sonner";

export function App() {
  useScrollFade();
  useZoom();
  useEffect(() => {
    const preventWindowFileNavigation = (event: DragEvent) => {
      event.preventDefault();
    };

    window.addEventListener("dragover", preventWindowFileNavigation);
    window.addEventListener("drop", preventWindowFileNavigation);

    const EDITABLE_SELECTOR =
      'input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

    const suppressNativeContextMenu = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(EDITABLE_SELECTOR)) return;
      event.preventDefault();
    };

    if (import.meta.env.PROD) {
      window.addEventListener("contextmenu", suppressNativeContextMenu);
    }

    // Dynamic import to avoid crash in non-Tauri environments (e.g., Playwright E2E)
    if (window.__TAURI_INTERNALS__) {
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        getCurrentWindow()
          .show()
          .catch(() => {});
      });
    }

    return () => {
      window.removeEventListener("dragover", preventWindowFileNavigation);
      window.removeEventListener("drop", preventWindowFileNavigation);
      if (import.meta.env.PROD) {
        window.removeEventListener("contextmenu", suppressNativeContextMenu);
      }
    };
  }, []);

  return (
    <>
      <TopBarActionsProvider>
        <AppShell />
      </TopBarActionsProvider>
      <Toaster />
    </>
  );
}
