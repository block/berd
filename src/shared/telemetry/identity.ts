/**
 * Resilient identity resolution for telemetry.
 *
 * Owns the asynchronous kgoose `whoami` round-trip that establishes the calling
 * user's identity, decoupled from the telemetry client itself. Resolution is
 * memoized so it runs at most once per session; a transient failure (off-WARP /
 * Access blip) is retried with capped exponential backoff and re-attempted
 * whenever the browser fires an `online` event, so blips self-heal mid-session.
 * A genuine anonymous answer (whoami succeeds but has no email) settles
 * immediately and is not retried.
 *
 * Callers wire `onIdentified` to apply the resolved identity (stamping it onto
 * each event's envelope) and register `whenResolved` to be notified once when
 * resolution settles.
 */

import { whoami } from "@/shared/api/whoami";
import { perfLog } from "@/shared/lib/perfLog";

export interface ResolvedIdentity {
  email: string;
}

// Capped exponential backoff for transient whoami failures.
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60 * 1_000;

export class IdentityProvider {
  private settled = false;
  private inFlight: Promise<void> | null = null;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private onlineListenerAdded = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly onIdentified: (identity: ResolvedIdentity) => void,
  ) {}

  /** True once resolution has settled, regardless of whether we got an email. */
  isSettled(): boolean {
    return this.settled;
  }

  /**
   * Register a one-shot callback fired when resolution settles (identity found
   * or confirmed anonymous). Fires immediately if already settled.
   */
  whenResolved(cb: () => void): void {
    if (this.settled) {
      cb();
      return;
    }
    this.listeners.add(cb);
  }

  /** Kick off (or return the in-flight) whoami round-trip. Idempotent. */
  ensureResolved(): Promise<void> {
    if (this.settled) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.attempt();
    return this.inFlight;
  }

  private async attempt(): Promise<void> {
    this.clearRetry();
    this.attempts += 1;

    // whoami() never throws — it returns null on any failure (off-WARP, Access
    // gate, parse error) and an object (possibly without an email) on success.
    const user = await whoami();
    this.inFlight = null;

    if (user === null) {
      // Transient failure: retry with backoff and on the next `online` event.
      this.scheduleRetry();
      return;
    }

    // Stable answer — identity if an email is present, otherwise anonymous.
    this.settle(user.email ? { email: user.email } : null);
  }

  private settle(identity: ResolvedIdentity | null): void {
    this.settled = true;
    this.clearRetry();

    if (identity) {
      try {
        this.onIdentified(identity);
      } catch (error) {
        perfLog(`[telemetry] failed to apply identity: ${String(error)}`);
      }
    }

    const pending = [...this.listeners];
    this.listeners.clear();
    for (const cb of pending) {
      try {
        cb();
      } catch (error) {
        perfLog(`[telemetry] identity listener failed: ${String(error)}`);
      }
    }
  }

  private scheduleRetry(): void {
    this.addOnlineListener();
    const ceiling = Math.min(
      BASE_BACKOFF_MS * 2 ** (this.attempts - 1),
      MAX_BACKOFF_MS,
    );
    // Half fixed, half jittered, so retries don't stampede on reconnect.
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.ensureResolved();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private addOnlineListener(): void {
    if (this.onlineListenerAdded || typeof window === "undefined") return;
    this.onlineListenerAdded = true;
    window.addEventListener("online", () => {
      void this.ensureResolved();
    });
  }
}
