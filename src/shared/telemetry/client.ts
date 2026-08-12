/**
 * Public telemetry seam.
 *
 * Berd's open-source build retains the call sites used by application startup
 * and successful feedback submission. Every entry point is inert; the internal
 * distribution overlays the real implementation at build time.
 */

/** Initializes telemetry in private distributions; inert in public Berd. */
export function initTelemetry(): void {}

/** Records app launch in private distributions; inert in public Berd. */
export function trackAppLaunched(): void {}

/** Records successful feedback in private distributions; inert in public Berd. */
export function trackFeedbackSubmitted(): void {}
