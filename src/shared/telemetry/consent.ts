/**
 * Renderer half of the telemetry consent setting.
 *
 * The source of truth is the Rust-owned `telemetry-settings.json` in the
 * app-data dir (see `src-tauri/src/commands/telemetry.rs`), which the native
 * export gate enforces independently of anything here. This module mirrors
 * that value into a small store so the client's per-event `telemetryEnabled()`
 * check can read it synchronously, and so the settings toggle can render it.
 *
 * Fail-closed by construction: consent is granted only when the build
 * enforces telemetry ON or the persisted setting has affirmatively loaded as
 * enabled. Before the load answers — and if it fails — consent reads as not
 * granted, so the failure mode is always dropped events, never leaked ones.
 */

import { create } from "zustand";
import {
  getTelemetrySettings,
  setTelemetryEnabled,
} from "@/shared/api/telemetrySettings";
import { perfLog } from "@/shared/lib/perfLog";
import { getBuildFeatureState } from "@/shared/profile/buildProfile";

interface TelemetryConsentState {
  /**
   * True once the persisted setting has answered — including a failed read,
   * which settles as disabled rather than leaving consent undecided forever.
   */
  loaded: boolean;
  /** The persisted user setting; false (the opt-in default) until loaded. */
  enabled: boolean;
}

export const useTelemetryConsentStore = create<TelemetryConsentState>(() => ({
  loaded: false,
  enabled: false,
}));

/**
 * Build-enforced consent: managed internal distributions force telemetry ON
 * and never render the toggle, so the persisted setting is skipped entirely.
 */
export function telemetryConsentEnforced(): boolean {
  return getBuildFeatureState().telemetryEnforced;
}

/** True once consent has a definitive answer (never while it is loading). */
export function telemetryConsentSettled(): boolean {
  return (
    telemetryConsentEnforced() || useTelemetryConsentStore.getState().loaded
  );
}

/**
 * The effective consent, fail-closed: enforced builds are always granted;
 * otherwise only an affirmatively loaded enabled setting grants it.
 */
export function telemetryConsentGranted(): boolean {
  if (telemetryConsentEnforced()) return true;
  const { loaded, enabled } = useTelemetryConsentStore.getState();
  return loaded && enabled;
}

let loadStarted = false;

/**
 * Kicks off the one read of the persisted setting for this renderer.
 * Idempotent; a no-op in enforced builds, where the file is never consulted.
 * A failed read settles the store as disabled — the fail-closed answer — and
 * is logged rather than retried: the value re-loads with the next renderer,
 * and the settings toggle writes repair it immediately.
 */
export function ensureTelemetryConsentLoaded(): void {
  if (loadStarted || telemetryConsentEnforced()) return;
  loadStarted = true;
  void getTelemetrySettings().then(
    ({ enabled }) =>
      useTelemetryConsentStore.setState({ loaded: true, enabled }),
    (error) => {
      perfLog(
        `[telemetry] failed to load the telemetry setting: ${String(error)}`,
      );
      useTelemetryConsentStore.setState({ loaded: true, enabled: false });
    },
  );
}

/**
 * Persists the user's choice natively, then reflects the value the Rust side
 * actually stored. Rejections propagate so the settings toggle can surface
 * the failure instead of showing a state that was never persisted.
 */
export async function updateTelemetryEnabled(enabled: boolean): Promise<void> {
  const settings = await setTelemetryEnabled(enabled);
  useTelemetryConsentStore.setState({
    loaded: true,
    enabled: settings.enabled,
  });
}
