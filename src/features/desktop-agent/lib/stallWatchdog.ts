// Stuck-send watchdog — ported from the prototype's semantics
// (the desktop agentSessionManager.sendStalled):
//
// - Armed (timer started, 25s) when activity enters `thinking`.
// - Re-armed on EACH incoming session notification — traffic proves
//   liveness and resets the clock.
// - Cleared (timer cancelled, flag false) when activity leaves `thinking`.
// - The send is never aborted; this only surfaces a hint.
//
// Pure class with an injectable timer factory so the semantics test without real time.

export type StallTimerFactory = (
  callback: () => void,
  ms: number,
) => () => void;

const defaultTimerFactory: StallTimerFactory = (callback, ms) => {
  const handle = setTimeout(callback, ms);
  return () => clearTimeout(handle);
};

export const STALL_THRESHOLD_MS = 25_000;

export class StallWatchdog {
  private cancel: (() => void) | null = null;
  private stalledInternal = false;

  constructor(
    private readonly onChange: (stalled: boolean) => void,
    private readonly timerFactory: StallTimerFactory = defaultTimerFactory,
    private readonly thresholdMs: number = STALL_THRESHOLD_MS,
  ) {}

  get stalled(): boolean {
    return this.stalledInternal;
  }

  /** Activity entered `thinking`: arm. */
  arm(): void {
    this.restartTimer();
  }

  /** A session notification arrived: liveness proven, re-arm. Only
   *  meaningful while armed — a clear watchdog stays clear. */
  noteTraffic(): void {
    if (this.cancel === null && !this.stalledInternal) return;
    this.setStalled(false);
    this.restartTimer();
  }

  /** Activity left `thinking` (responding or none), or detach/dispose. */
  clear(): void {
    this.cancel?.();
    this.cancel = null;
    this.setStalled(false);
  }

  private restartTimer(): void {
    this.cancel?.();
    this.cancel = this.timerFactory(() => {
      this.cancel = null;
      this.setStalled(true);
    }, this.thresholdMs);
  }

  private setStalled(next: boolean): void {
    if (this.stalledInternal === next) return;
    this.stalledInternal = next;
    this.onChange(next);
  }
}
