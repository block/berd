import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";

import { preloadStartupLoadingMedia } from "@/app/lib/preloadStartupLoadingMedia";
import { App } from "@/app/App";
import { LocalMediaCacheEvents } from "@/app/LocalMediaCacheEvents";
import { UpdaterProvider } from "@/features/updates/hooks/useUpdater";
import { I18nProvider } from "@/shared/i18n";
import { ThemeProvider } from "@/shared/theme/ThemeProvider";
import "@xterm/xterm/css/xterm.css";
import "@/shared/styles/globals.css";

// One-time cleanup of legacy onboarding state from previous builds. Safe to
// remove once we're confident no users still carry this localStorage entry.
try {
  localStorage.removeItem("goose:onboarding:v1");
} catch {
  // localStorage may be unavailable in some environments; ignore.
}

preloadStartupLoadingMedia();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <LocalMediaCacheEvents />
      <I18nProvider>
        <ThemeProvider>
          <UpdaterProvider>
            <App />
          </UpdaterProvider>
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
