import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";

import { AcpToolsEvents } from "@/app/AcpToolsEvents";
import { TopBarActionsProvider } from "@/app/contexts/TopBarActionsContext";
import { GitStateEvents } from "@/app/GitStateEvents";
import { LocalMediaCacheEvents } from "@/app/LocalMediaCacheEvents";
import { SelectedTextContextMenu } from "@/app/ui/SelectedTextContextMenu";
import { useSessionWindowTracking } from "@/features/chat/hooks/useSessionWindowTracking";
import { useWorkspaceAttachmentSync } from "@/features/chat/hooks/useWorkspaceAttachmentSync";
import { usePendingSessionWorkspaceActivationDrain } from "@/features/berdctl/bridge/usePendingSessionWorkspaceActivationDrain";
import { useZoom } from "@/shared/hooks/useZoom";
import { I18nProvider } from "@/shared/i18n";
import { ThemeProvider } from "@/shared/theme/ThemeProvider";
import { Toaster } from "@/shared/ui/sonner";

interface SessionWindowRuntimeProps {
  queryClient: QueryClient;
  sessionId: string;
  children: ReactNode;
}

export function SessionWindowRuntime({
  queryClient,
  sessionId,
  children,
}: SessionWindowRuntimeProps) {
  useZoom();
  useSessionWindowTracking();
  useWorkspaceAttachmentSync();
  usePendingSessionWorkspaceActivationDrain({
    allowWindowed: true,
    sessionId,
  });

  useEffect(() => {
    const preventWindowFileNavigation = (event: DragEvent) => {
      event.preventDefault();
    };

    window.addEventListener("dragover", preventWindowFileNavigation);
    window.addEventListener("drop", preventWindowFileNavigation);

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
    <QueryClientProvider client={queryClient}>
      <AcpToolsEvents />
      <GitStateEvents />
      <LocalMediaCacheEvents />
      <I18nProvider>
        <ThemeProvider>
          <TopBarActionsProvider>{children}</TopBarActionsProvider>
          <SelectedTextContextMenu />
          <Toaster />
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
