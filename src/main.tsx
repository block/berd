import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";

import { preloadStartupLoadingMedia } from "@/app/lib/preloadStartupLoadingMedia";
import { App } from "@/app/App";
import { LocalMediaCacheEvents } from "@/app/LocalMediaCacheEvents";
import { RendererTelemetry } from "@/app/RendererTelemetry";
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
const appRoot: HTMLElement = root;
const reactRoot = ReactDOM.createRoot(appRoot);

function decodeSessionKey(sessionKey: string): string {
  const base64 = sessionKey.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function renderBootError(message: string) {
  reactRoot.render(
    <React.StrictMode>
      <div className="flex h-screen min-w-0 flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground">
        <h1 className="font-medium text-lg">Session window failed to load</h1>
        <p className="max-w-md text-muted-foreground text-sm">{message}</p>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    </React.StrictMode>,
  );
}

const sessionKey = new URLSearchParams(window.location.search).get(
  "sessionKey",
);
let sessionId: string | null = null;
let bootError: string | null = null;
if (sessionKey) {
  try {
    sessionId = decodeSessionKey(sessionKey);
  } catch (error) {
    console.error("Failed to decode session window key:", error);
    bootError = "The session window URL is malformed.";
  }
}

if (bootError) {
  renderBootError(bootError);
} else if (sessionId) {
  const decodedSessionId = sessionId;
  Promise.all([
    import("@/app/SessionWindowApp"),
    import("@/app/SessionWindowRuntime"),
  ])
    .then(([{ SessionWindowApp }, { SessionWindowRuntime }]) => {
      reactRoot.render(
        <React.StrictMode>
          <SessionWindowRuntime queryClient={queryClient}>
            <SessionWindowApp sessionId={decodedSessionId} />
          </SessionWindowRuntime>
        </React.StrictMode>,
      );
    })
    .catch((error) => {
      console.error("Failed to load session window bundle:", error);
      renderBootError("The session window bundle could not be loaded.");
    });
} else {
  reactRoot.render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <LocalMediaCacheEvents />
        <RendererTelemetry />
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
