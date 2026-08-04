export interface ShareInFlightOptions {
  /**
   * Ignore any request already in flight and start a new one. Use right after a
   * write whose effect this fetch must observe: a plain call would otherwise
   * coalesce onto a sibling's read that started before the write and resolve
   * with pre-write state. The new request becomes the shared one, so concurrent
   * plain callers still collapse onto it.
   */
  fresh?: boolean;
}

/**
 * Wrap an idempotent async fn so concurrent callers share one in-flight
 * promise. Components that fetch the same backend state independently on
 * mount (StrictMode double-fires, several hooks alive in the same tick)
 * collapse to a single request; once it settles, the next call fetches
 * fresh so user-driven refreshes never see stale data.
 */
export function shareInFlight<T>(
  fn: () => Promise<T>,
): (options?: ShareInFlightOptions) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return (options) => {
    if (options?.fresh || !inFlight) {
      const request = Promise.resolve()
        .then(fn)
        // Only clear the slot if it still points at this request: a `fresh`
        // call replaces `inFlight` mid-flight, and the superseded request's
        // settle must not null out its successor.
        .finally(() => {
          if (inFlight === request) {
            inFlight = null;
          }
        });
      inFlight = request;
    }
    return inFlight;
  };
}
