import { useEffect, type ReactNode } from "react";

import { AppShell } from "@/app/AppShell";
import { TopBarActionsProvider } from "@/app/contexts/TopBarActionsContext";
import { SelectedTextContextMenu } from "@/app/ui/SelectedTextContextMenu";
import { StartupLoadingView } from "@/app/ui/StartupLoadingView";
import { useAuthGate } from "@/features/auth/hooks/useAuthGate";
import { GlobalShortcutBridge } from "@/features/global-shortcut/GlobalShortcutBridge";
import { LoginView } from "@/features/auth/ui/LoginView";
import { getBuildFeatureState } from "@/shared/profile/buildProfile";
import { useZoom } from "@/shared/hooks/useZoom";
import { Toaster } from "@/shared/ui/sonner";
import { SecurityConfirmationFallback } from "@/features/security/ui/SecurityConfirmationPanel";

export function App() {
  useZoom();
  const buildFeatures = getBuildFeatureState();
  const authGateEnabled = buildFeatures.authGate;
  const authGate = useAuthGate(authGateEnabled);

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

  let content: ReactNode;
  if (authGate.status === "loading") {
    content = <StartupLoadingView />;
  } else if (authGate.status === "loggedIn") {
    content = (
      <TopBarActionsProvider>
        <GlobalShortcutBridge />
        <AppShell
          authStatus={authGate.authStatus}
          onLoggedOut={authGate.completeLogin}
        />
      </TopBarActionsProvider>
    );
  } else {
    content = (
      <LoginView
        authStatus={authGate.authStatus}
        statusError={authGate.error}
        onRetryStatus={authGate.retry}
        onAuthenticated={authGate.completeLogin}
      />
    );
  }

  return (
    <>
      {content}
      {authGate.status === "loggedIn" ? <SelectedTextContextMenu /> : null}
      <SecurityConfirmationFallback />
      <Toaster />
    </>
  );
}
