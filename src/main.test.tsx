import { act, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInstallRendererDiagnostics = vi.hoisted(() => vi.fn());
const mockReportRendererError = vi.hoisted(() => vi.fn());
const mockInvoke = vi.hoisted(() => vi.fn());

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

vi.mock("@/app/ui/StartupLoadingView", () => ({
  StartupLoadingView: () => <div data-testid="startup-loading" />,
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

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

vi.mock("@/shared/theme/ThemeProvider", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

async function loadMainAt(search: string) {
  window.history.replaceState({}, "", `/${search}`);
  document.body.innerHTML = '<div id="root"></div>';
  await act(async () => {
    await import("./main");
  });
}

describe("main entrypoint telemetry startup", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    localStorage.clear();
    mockInvoke.mockResolvedValue("fresh-with-landing-v1");
    globalThis.fetch = vi.fn() as typeof globalThis.fetch;
  });

  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // The one native command the main window's boot may issue is the
  // installation-cohort lookup — telemetry itself stays off the network and
  // off native commands in this build.
  it("resolves the installation cohort before rendering the main app, with no telemetry work", async () => {
    await loadMainAt("");

    await screen.findByTestId("main-app");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledOnce();
    expect(mockInvoke).toHaveBeenCalledWith("get_installation_cohort");
    expect(mockInstallRendererDiagnostics).toHaveBeenCalledWith({
      windowKind: "main",
    });
  });

  it("reports cohort lookup failures without blocking startup", async () => {
    const error = new Error("state unavailable");
    mockInvoke.mockRejectedValueOnce(error);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await loadMainAt("");

    await screen.findByTestId("main-app");
    expect(mockReportRendererError).toHaveBeenCalledWith(
      "installation_cohort_failed",
      error,
    );
  });

  it("runs the session window startup path without telemetry network or native-command work", async () => {
    await loadMainAt("?sessionKey=c2Vzc2lvbi0xMjM");

    expect(await screen.findByTestId("session-app")).toHaveTextContent(
      "session-123",
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
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
    expect(mockReportRendererError).toHaveBeenCalledWith(
      "session_key_decode_failed",
      expect.anything(),
    );
    expect(mockInstallRendererDiagnostics).toHaveBeenCalledWith({
      windowKind: "main",
    });
    consoleError.mockRestore();
  });

  // Pins which boot branches initialize the telemetry pipeline vs. fire the
  // launch event. Session windows run the same instrumented chat send paths as
  // the main window, so they must initialize the pipeline (or every event they
  // track is silently dropped) — but opening one is not an app start, so they
  // must never emit the launch event.
  describe("per-window-kind telemetry wiring", () => {
    const mockInitTelemetry = vi.fn();
    const mockTrackAppLaunched = vi.fn();

    beforeEach(() => {
      vi.doMock("@/shared/telemetry/client", () => ({
        initTelemetry: mockInitTelemetry,
        track: vi.fn(),
        trackAppLaunched: mockTrackAppLaunched,
      }));
    });

    afterEach(() => {
      vi.doUnmock("@/shared/telemetry/client");
    });

    it("main window initializes telemetry, then fires the launch event once", async () => {
      await loadMainAt("");

      await screen.findByTestId("main-app");
      expect(mockInitTelemetry).toHaveBeenCalledTimes(1);
      expect(mockTrackAppLaunched).toHaveBeenCalledTimes(1);
      expect(mockInitTelemetry.mock.invocationCallOrder[0]).toBeLessThan(
        mockTrackAppLaunched.mock.invocationCallOrder[0],
      );
    });

    it("session window initializes telemetry without firing the launch event", async () => {
      await loadMainAt("?sessionKey=c2Vzc2lvbi0xMjM");

      await screen.findByTestId("session-app");
      expect(mockInitTelemetry).toHaveBeenCalledTimes(1);
      expect(mockTrackAppLaunched).not.toHaveBeenCalled();
    });

    it("malformed session window boot error initializes nothing", async () => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      await loadMainAt("?sessionKey=*");

      await waitFor(() => {
        expect(
          screen.getByRole("heading", {
            name: "Session window failed to load",
          }),
        ).toBeInTheDocument();
      });
      expect(mockInitTelemetry).not.toHaveBeenCalled();
      expect(mockTrackAppLaunched).not.toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });
});
