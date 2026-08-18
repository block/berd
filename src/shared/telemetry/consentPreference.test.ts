import { beforeEach, describe, expect, it } from "vitest";
import { getTelemetryConsent, setTelemetryConsent } from "./consentPreference";

describe("telemetry consent preference", () => {
  beforeEach(() => localStorage.clear());

  it("is unset until an explicit choice is persisted", () => {
    expect(getTelemetryConsent()).toBeNull();
    expect(setTelemetryConsent(false)).toBe(true);
    expect(getTelemetryConsent()).toBe(false);
    expect(setTelemetryConsent(true)).toBe(true);
    expect(getTelemetryConsent()).toBe(true);
  });

  it("fails closed for malformed values", () => {
    localStorage.setItem("berd:telemetry-consent:v1", "yes");
    expect(getTelemetryConsent()).toBeNull();
  });
});
