import { useEffect } from "react";

import { AppShell } from "@/app/AppShell";
import { TopBarActionsProvider } from "@/app/contexts/TopBarActionsContext";
import { SelectedTextContextMenu } from "@/app/ui/SelectedTextContextMenu";
import { useZoom } from "@/shared/hooks/useZoom";
import { Toaster } from "@/shared/ui/sonner";

export function App() {
  useZoom();
  useEffect(() => {
    const preventWindowFileNavigation = (event: DragEvent) => {
      event.preventDefault();
    };

    window.addEventListener("dragover", preventWindowFileNavigation);
    window.addEventListener("drop", preventWindowFileNavigation);

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
    };
  }, []);

  return (
    <>
      <TopBarActionsProvider>
        <AppShell />
      </TopBarActionsProvider>
      <SelectedTextContextMenu />
      <Toaster />
    </>
  );
}
