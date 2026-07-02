import { screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInitTelemetry = vi.hoisted(() => vi.fn());
const mockInstallRendererDiagnostics = vi.hoisted(() => vi.fn());
const mockReportRendererError = vi.hoisted(() => vi.fn());
const mockTrackAppLaunched = vi.hoisted(() => vi.fn());

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@/shared/styles/globals.css", () => ({}));

vi.mock("@/app/App", () => ({
  App: () => <div data-testid="main-app" />,
}));

vi.mock("@/app/LocalMediaCacheEvents", () => ({
  LocalMediaCacheEvents: () => null,
}));

vi.mock("@/app/RendererTelemetry", () => ({
  RendererTelemetry: () => null,
}));

vi.mock("@/app/SessionWindowApp", () => ({
  SessionWindowApp: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="session-app">{sessionId}</div>
  ),
}));

vi.mock("@/app/SessionWindowRuntime", () => ({
  SessionWindowRuntime: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/app/lib/rendererDiagnostics", () => ({
  installRendererDiagnostics: mockInstallRendererDiagnostics,
  reportRendererError: mockReportRendererError,
}));

vi.mock("@/app/ui/RendererErrorBoundary", () => ({
  RendererErrorBoundary: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/features/updates/hooks/useUpdater", () => ({
  UpdaterProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/shared/i18n", () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/shared/telemetry/client", () => ({
  initTelemetry: mockInitTelemetry,
  trackAppLaunched: mockTrackAppLaunched,
}));

vi.mock("@/shared/theme/ThemeProvider", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

async function loadMainAt(search: string) {
  window.history.replaceState({}, "", `/${search}`);
  document.body.innerHTML = '<div id="root"></div>';
  await import("./main");
}

describe("main entrypoint telemetry startup", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("starts telemetry once for the main app window", async () => {
    await loadMainAt("");

    await screen.findByTestId("main-app");
    expect(mockInitTelemetry).toHaveBeenCalledTimes(1);
    expect(mockTrackAppLaunched).toHaveBeenCalledTimes(1);
    expect(mockInstallRendererDiagnostics).toHaveBeenCalledWith({
      windowKind: "main",
    });
  });

  it("does not start launch telemetry for session windows", async () => {
    await loadMainAt("?sessionKey=c2Vzc2lvbi0xMjM");

    expect(await screen.findByTestId("session-app")).toHaveTextContent(
      "session-123",
    );
    expect(mockInitTelemetry).not.toHaveBeenCalled();
    expect(mockTrackAppLaunched).not.toHaveBeenCalled();
    expect(mockInstallRendererDiagnostics).toHaveBeenCalledWith({
      windowKind: "session",
    });
  });

  it("does not start launch telemetry for malformed session windows", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await loadMainAt("?sessionKey=*");

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Session window failed to load" }),
      ).toBeInTheDocument();
    });
    expect(mockInitTelemetry).not.toHaveBeenCalled();
    expect(mockTrackAppLaunched).not.toHaveBeenCalled();
    expect(mockReportRendererError).toHaveBeenCalledWith(
      "session_key_decode_failed",
      expect.anything(),
    );
    expect(mockInstallRendererDiagnostics).toHaveBeenCalledWith({
      windowKind: "main",
    });
    consoleError.mockRestore();
  });
});
