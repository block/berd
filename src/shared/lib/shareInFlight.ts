export interface ShareInFlightOptions {
  /**
   * Join a request already in flight instead of starting a new one. Opt in from
   * a startup or mount window where several surfaces read the same state in the
   * same tick and any in-flight read is acceptable — the cost of getting this
   * wrong is a stale read, so it is never the default.
   */
  coalesce?: boolean;
}

/**
 * Wrap an idempotent async fn so callers that opt in with `{ coalesce: true }`
 * share one in-flight promise. Surfaces that fetch the same backend state
 * independently on mount (StrictMode double-fires, several hooks alive in the
 * same tick) collapse to a single request.
 *
 * A plain call always fetches, so a read that must observe a just-completed
 * write needs no option to stay correct. Every call — coalescing or not —
 * publishes its request as the shared one, so a post-write read supersedes a
 * pre-write read still in flight and a `coalesce` caller arriving later joins
 * the post-write read rather than the stale one.
 */
export function shareInFlight<T>(
  fn: () => Promise<T>,
): (options?: ShareInFlightOptions) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return (options) => {
    if (!options?.coalesce || !inFlight) {
      const request = Promise.resolve()
        .then(fn)
        // Only clear the slot if it still points at this request: a plain call
        // replaces `inFlight` mid-flight, and the superseded request's settle
        // must not null out its successor.
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
