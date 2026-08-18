/**
 * Chat-runtime startup as the onboarding steps see it.
 *
 * Onboarding renders ahead of `AppShell`'s startup gates so the landing page —
 * the surface that asks for telemetry consent — never waits on the `goosed`
 * sidecar. Steps that do call the runtime take this instead of assuming it is
 * up: `ready` means startup settled without an issue, `failed` means it settled
 * with one, and `retry` re-runs it.
 */
export interface OnboardingRuntimeState {
  ready: boolean;
  failed: boolean;
  retry: () => void;
}
