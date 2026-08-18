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
    mockInvoke.mockResolvedValue("fresh-with-landing-v1");
    globalThis.fetch = vi.fn() as typeof globalThis.fetch;
  });

  afterEach(() => {
    document.body.innerHTML = "";
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("resolves the installation cohort before rendering the main app", async () => {
    await loadMainAt("");

    await screen.findByTestId("main-app");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledOnce();
    expect(mockInvoke).toHaveBeenCalledWith("get_installation_cohort");
    expect(mockInstallRendererDiagnostics).toHaveBeenCalledWith({
      windowKind: "main",
    });
  });

  it("does not start launch telemetry for session windows", async () => {
    await loadMainAt("?sessionKey=c2Vzc2lvbi0xMjM");

    expect(await screen.findByTestId("session-app")).toHaveTextContent(
      "session-123",
    );
    expect(mockInstallRendererDiagnostics).toHaveBeenCalledWith({
      windowKind: "session",
    });
    expect(mockInvoke).not.toHaveBeenCalled();
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
});
