const TELEMETRY_CONSENT_STORAGE_KEY = "berd:telemetry-consent:v1";

export function getTelemetryConsent(): boolean | null {
  try {
    const value = localStorage.getItem(TELEMETRY_CONSENT_STORAGE_KEY);
    if (value === "true") return true;
    if (value === "false") return false;
  } catch {
    // Missing storage is treated as no consent.
  }
  return null;
}

export function setTelemetryConsent(enabled: boolean): boolean {
  try {
    localStorage.setItem(TELEMETRY_CONSENT_STORAGE_KEY, String(enabled));
    return getTelemetryConsent() === enabled;
  } catch {
    return false;
  }
}
