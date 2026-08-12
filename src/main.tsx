import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";

import {
  installRendererDiagnostics,
  reportRendererError,
} from "@/app/lib/rendererDiagnostics";
import { AcpToolsEvents } from "@/app/AcpToolsEvents";
import { App } from "@/app/App";
import { GitStateEvents } from "@/app/GitStateEvents";
import { LocalMediaCacheEvents } from "@/app/LocalMediaCacheEvents";
import { RendererTelemetry } from "@/app/RendererTelemetry";
import { ReleasedQueuedMessageDrain } from "@/features/chat/ui/ReleasedQueuedMessageDrain";
import { UpdaterProvider } from "@/features/updates/hooks/useUpdater";
import { I18nProvider } from "@/shared/i18n";
import { initTelemetry, trackAppLaunched } from "@/shared/telemetry/client";
import { ThemeProvider } from "@/shared/theme/ThemeProvider";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { RendererErrorBoundary } from "@/app/ui/RendererErrorBoundary";
import "@xterm/xterm/css/xterm.css";
import "@/shared/styles/globals.css";

// One-time cleanup of legacy onboarding state from previous builds. Safe to
// remove once we're confident no users still carry this localStorage entry.
try {
  localStorage.removeItem("goose:onboarding:v1");
} catch {
  // localStorage may be unavailable in some environments; ignore.
}

// React Query's default focus detection relies on `visibilitychange`, which
// the Tauri webview does not fire when the app window merely loses or regains
// OS focus. Drive it from real window focus events so queries opted into
// refetchOnWindowFocus re-sync when the user comes back to the app.
focusManager.setEventListener((handleFocus) => {
  const onFocus = () => handleFocus(true);
  const onBlur = () => handleFocus(false);
  const onVisibilityChange = () =>
    handleFocus(document.visibilityState !== "hidden");
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
});

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
      <div className="flex h-screen min-w-0 flex-col items-center justify-center gap-3 bg-canvas-base px-6 text-center text-foreground">
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

function OptionalBerdctlBridge() {
  const [Bridge, setBridge] = React.useState<React.ComponentType | null>(null);

  React.useEffect(() => {
    let mounted = true;
    import("@/features/berdctl/bridge/BerdctlBridge")
      .then(({ BerdctlBridge }) => {
        if (mounted) {
          setBridge(() => BerdctlBridge);
        }
      })
      .catch((error) => {
        console.error("Failed to load berdctl bridge:", error);
        reportRendererError("berdctl_bridge_load_failed", error);
      });
    return () => {
      mounted = false;
    };
  }, []);

  return Bridge ? <Bridge /> : null;
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
    reportRendererError("session_key_decode_failed", error);
    bootError = "The session window URL is malformed.";
  }
}

installRendererDiagnostics({ windowKind: sessionId ? "session" : "main" });

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
          <TooltipProvider>
            <RendererErrorBoundary>
              <SessionWindowRuntime
                queryClient={queryClient}
                sessionId={decodedSessionId}
              >
                <SessionWindowApp sessionId={decodedSessionId} />
              </SessionWindowRuntime>
            </RendererErrorBoundary>
          </TooltipProvider>
        </React.StrictMode>,
      );
    })
    .catch((error) => {
      console.error("Failed to load session window bundle:", error);
      reportRendererError("session_window_bundle_load_failed", error);
      renderBootError("The session window bundle could not be loaded.");
    });
} else {
  initTelemetry();
  trackAppLaunched();

  reactRoot.render(
    <React.StrictMode>
      <TooltipProvider>
        <RendererErrorBoundary>
          <QueryClientProvider client={queryClient}>
            <AcpToolsEvents />
            <GitStateEvents />
            <LocalMediaCacheEvents />
            <ReleasedQueuedMessageDrain />
            <OptionalBerdctlBridge />
            <RendererTelemetry />
            <I18nProvider>
              <ThemeProvider>
                <UpdaterProvider>
                  <App />
                </UpdaterProvider>
              </ThemeProvider>
            </I18nProvider>
          </QueryClientProvider>
        </RendererErrorBoundary>
      </TooltipProvider>
    </React.StrictMode>,
  );
}
