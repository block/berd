import { initTelemetry, trackAppLaunched } from "@/shared/telemetry/client";
import { getTelemetryConsent } from "@/shared/telemetry/consentPreference";

let started = false;

export function startTelemetryIfConsented(): boolean {
  if (started || getTelemetryConsent() !== true) return false;
  started = true;
  initTelemetry();
  trackAppLaunched();
  return true;
}

export function resetTelemetryStartupForTests(): void {
  started = false;
}
