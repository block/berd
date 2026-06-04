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

function decodeSessionKey(sessionKey: string): string {
  const base64 = sessionKey.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const sessionKey = new URLSearchParams(window.location.search).get(
  "sessionKey",
);
const sessionId = sessionKey ? decodeSessionKey(sessionKey) : null;

if (sessionId) {
  Promise.all([
    import("@/app/SessionWindowApp"),
    import("@/app/SessionWindowRuntime"),
  ]).then(([{ SessionWindowApp }, { SessionWindowRuntime }]) => {
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <SessionWindowRuntime queryClient={queryClient}>
          <SessionWindowApp sessionId={sessionId} />
        </SessionWindowRuntime>
      </React.StrictMode>,
    );
  });
} else {
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
}
