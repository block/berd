// Ported from the prototype's watchdog stall cases: thinking + 25s
// silence -> stalled; traffic re-arms; leaving thinking clears; no late
// fires after clear.

import { describe, expect, test } from "vitest";

import { StallWatchdog, type StallTimerFactory } from "./stallWatchdog";

/** Manual timer harness: fires only when told to. */
class FakeTimers {
  pending: Array<{ callback: () => void; ms: number; cancelled: boolean }> = [];

  factory: StallTimerFactory = (callback, ms) => {
    const entry = { callback, ms, cancelled: false };
    this.pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };

  /** Fires the most recent uncancelled timer (simulating threshold elapse).
   *  A fired one-shot is dead: mark it consumed so liveCount stays honest. */
  fireLatest(): void {
    const live = this.pending.filter((t) => !t.cancelled);
    const latest = live[live.length - 1];
    if (latest) {
      latest.cancelled = true;
      latest.callback();
    }
  }

  get liveCount(): number {
    return this.pending.filter((t) => !t.cancelled).length;
  }
}

function harness() {
  const timers = new FakeTimers();
  const changes: boolean[] = [];
  const watchdog = new StallWatchdog(
    (stalled) => changes.push(stalled),
    timers.factory,
  );
  return { timers, changes, watchdog };
}

describe("StallWatchdog", () => {
  test("thinking + threshold silence -> stalled", () => {
    const { timers, changes, watchdog } = harness();
    watchdog.arm();
    expect(watchdog.stalled).toBe(false);

    timers.fireLatest();

    expect(watchdog.stalled).toBe(true);
    expect(changes).toEqual([true]);
  });

  test("traffic re-arms: old timer cancelled, new one started", () => {
    const { timers, watchdog } = harness();
    watchdog.arm();
    watchdog.noteTraffic();

    // The armed timer was replaced — exactly one live timer remains.
    expect(timers.liveCount).toBe(1);
    expect(watchdog.stalled).toBe(false);
  });

  test("stalled then traffic resumes -> clears and re-arms", () => {
    const { timers, changes, watchdog } = harness();
    watchdog.arm();
    timers.fireLatest();
    expect(watchdog.stalled).toBe(true);

    watchdog.noteTraffic();

    expect(watchdog.stalled).toBe(false);
    expect(changes).toEqual([true, false]);
    expect(timers.liveCount).toBe(1); // re-armed
  });

  test("leaving thinking clears without firing", () => {
    const { timers, changes, watchdog } = harness();
    watchdog.arm();
    watchdog.clear();

    expect(timers.liveCount).toBe(0);
    expect(watchdog.stalled).toBe(false);
    expect(changes).toEqual([]); // never became stalled, no spurious change
  });

  test("clear cancels the armed timer (the no-late-fire guarantee)", () => {
    // The no-late-fire property rests on clear() actually cancelling the
    // host timer — a real clearTimeout never fires a cancelled callback.
    // Assert the cancellation itself: this test FAILS if clear() stops
    // invoking the cancel handle (unlike its tautological predecessor,
    // which couldn't fail — review nit).
    const { timers, changes, watchdog } = harness();
    watchdog.arm();
    expect(timers.liveCount).toBe(1);

    watchdog.clear();

    expect(timers.pending[0].cancelled).toBe(true);
    expect(timers.liveCount).toBe(0);
    expect(watchdog.stalled).toBe(false);
    expect(changes).toEqual([]);
  });

  test("traffic while idle is a no-op (clear watchdog stays clear)", () => {
    const { timers, changes, watchdog } = harness();
    watchdog.noteTraffic();

    expect(timers.liveCount).toBe(0);
    expect(changes).toEqual([]);
  });
});
