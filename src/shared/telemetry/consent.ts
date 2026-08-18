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
 * is logged rather than retried: the value re-loads with the next renderer.
 *
 * The read only ever settles a store that is still unsettled; a user write
 * that lands first wins. Because the `loadStarted` guard admits exactly one
 * read, `loaded` being true at resolution time can only mean
 * `updateTelemetryEnabled` settled first, and that write's stored value
 * reflects what the native side holds *after* this read's snapshot was taken.
 * Overwriting it would silently revoke consent the user just granted (or,
 * on the failure branch, force-disable it) for the rest of the session.
 */
export function ensureTelemetryConsentLoaded(): void {
  if (loadStarted || telemetryConsentEnforced()) return;
  loadStarted = true;
  const settleFromRead = (enabled: boolean) => {
    if (useTelemetryConsentStore.getState().loaded) return;
    useTelemetryConsentStore.setState({ loaded: true, enabled });
  };
  void getTelemetrySettings().then(
    ({ enabled }) => settleFromRead(enabled),
    (error) => {
      // Logged unconditionally: a failed read is worth recording even when a
      // user write already superseded the value it would have settled.
      perfLog(
        `[telemetry] failed to load the telemetry setting: ${String(error)}`,
      );
      settleFromRead(false);
    },
  );
}

/**
 * Persists the user's choice natively, then reflects the value the Rust side
 * actually stored. Rejections propagate so the settings toggle can surface
 * the failure instead of showing a state that was never persisted.
 *
 * This overwrites unconditionally — a completed write is the freshest fact
 * about the persisted setting, so it outranks the boot read either way round.
 */
export async function updateTelemetryEnabled(enabled: boolean): Promise<void> {
  const settings = await setTelemetryEnabled(enabled);
  useTelemetryConsentStore.setState({
    loaded: true,
    enabled: settings.enabled,
  });
}
