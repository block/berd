import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetTelemetryStartupForTests,
  startTelemetryIfConsented,
} from "./startup";

const telemetry = vi.hoisted(() => ({ init: vi.fn(), launch: vi.fn() }));
vi.mock("@/shared/telemetry/client", () => ({
  initTelemetry: telemetry.init,
  trackAppLaunched: telemetry.launch,
}));

const diagnostics = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock("@/app/lib/rendererDiagnostics", () => ({
  reportRendererError: diagnostics.report,
}));

describe("telemetry startup", () => {
  beforeEach(() => {
    localStorage.clear();
    telemetry.init.mockReset();
    telemetry.launch.mockReset();
    diagnostics.report.mockClear();
    resetTelemetryStartupForTests();
  });

  it("starts once only after explicit consent", () => {
    expect(startTelemetryIfConsented()).toBe(false);
    localStorage.setItem("berd:telemetry-consent:v1", "true");
    expect(startTelemetryIfConsented()).toBe(true);
    expect(startTelemetryIfConsented()).toBe(false);
    expect(telemetry.init).toHaveBeenCalledOnce();
    expect(telemetry.launch).toHaveBeenCalledOnce();
  });

  it("does not start after opt out", () => {
    localStorage.setItem("berd:telemetry-consent:v1", "false");
    expect(startTelemetryIfConsented()).toBe(false);
    expect(telemetry.init).not.toHaveBeenCalled();
  });

  it("reports a failed init without throwing or retrying", () => {
    const error = new Error("analytics unavailable");
    telemetry.init.mockImplementation(() => {
      throw error;
    });
    localStorage.setItem("berd:telemetry-consent:v1", "true");

    expect(startTelemetryIfConsented()).toBe(false);
    expect(telemetry.launch).not.toHaveBeenCalled();
    expect(diagnostics.report).toHaveBeenCalledWith(
      "telemetry_init_failed",
      error,
    );

    expect(startTelemetryIfConsented()).toBe(false);
    expect(telemetry.init).toHaveBeenCalledOnce();
  });

  it("keeps telemetry started when the launch event fails", () => {
    const error = new Error("event queue full");
    telemetry.launch.mockImplementation(() => {
      throw error;
    });
    localStorage.setItem("berd:telemetry-consent:v1", "true");

    expect(startTelemetryIfConsented()).toBe(true);
    expect(telemetry.init).toHaveBeenCalledOnce();
    expect(diagnostics.report).toHaveBeenCalledWith(
      "telemetry_launch_event_failed",
      error,
    );
  });
});
