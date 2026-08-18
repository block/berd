import { reportRendererError } from "@/app/lib/rendererDiagnostics";
import { initTelemetry, trackAppLaunched } from "@/shared/telemetry/client";
import { getTelemetryConsent } from "@/shared/telemetry/consentPreference";

let started = false;

/**
 * Best-effort: telemetry never gates onboarding or rendering. One init attempt
 * per renderer process — a failed init disables telemetry until relaunch rather
 * than retrying into a failing SDK. Returns whether telemetry is now running.
 */
export function startTelemetryIfConsented(): boolean {
  if (started || getTelemetryConsent() !== true) return false;
  started = true;

  try {
    initTelemetry();
  } catch (error) {
    reportRendererError("telemetry_init_failed", error);
    return false;
  }

  // Init succeeded, so losing one launch event is not worth disabling telemetry.
  try {
    trackAppLaunched();
  } catch (error) {
    reportRendererError("telemetry_launch_event_failed", error);
  }
  return true;
}

export function resetTelemetryStartupForTests(): void {
  started = false;
}
