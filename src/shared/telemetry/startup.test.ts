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

describe("telemetry startup", () => {
  beforeEach(() => {
    localStorage.clear();
    telemetry.init.mockClear();
    telemetry.launch.mockClear();
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
});
