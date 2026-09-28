// Matches the previous hardcoded TOAST_DURATION_MS in
// CompletionNotificationToast.tsx.
export const DEFAULT_TOAST_DURATION_SECONDS = 8;
export const MIN_TOAST_DURATION_SECONDS = 3;
export const MAX_TOAST_DURATION_SECONDS = 60;
// A sentinel value meaning "never auto-dismiss".
export const NEVER_DISMISS_TOAST_DURATION_SECONDS = 0;

/**
 * Normalizes a stored/user-provided toast duration (in seconds) into a value
 * that is safe to hand to the toast delivery layer: either the never-dismiss
 * sentinel, or an integer clamped to [MIN_TOAST_DURATION_SECONDS,
 * MAX_TOAST_DURATION_SECONDS]. Falls back to the default for missing or
 * non-finite input.
 */
export function clampToastDurationSeconds(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_TOAST_DURATION_SECONDS;
  }
  // Only the exact sentinel means never-dismiss. Anything below it is
  // corrupted/incompatible data, not an intentional "persistent" choice, so
  // it recovers to the safe timed default instead of silently becoming
  // never-dismiss.
  if (value === NEVER_DISMISS_TOAST_DURATION_SECONDS) {
    return NEVER_DISMISS_TOAST_DURATION_SECONDS;
  }
  if (value < NEVER_DISMISS_TOAST_DURATION_SECONDS) {
    return DEFAULT_TOAST_DURATION_SECONDS;
  }
  return Math.min(
    MAX_TOAST_DURATION_SECONDS,
    Math.max(MIN_TOAST_DURATION_SECONDS, Math.round(value)),
  );
}

/** Converts a normalized toast duration (seconds) to the value sonner expects. */
export function toastDurationSecondsToMs(durationSeconds: number): number {
  return durationSeconds === NEVER_DISMISS_TOAST_DURATION_SECONDS
    ? Number.POSITIVE_INFINITY
    : clampToastDurationSeconds(durationSeconds) * 1000;
}
