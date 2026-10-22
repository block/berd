// Fake-driven tests for the panel connection lifecycle: single-flight
// attach, the one automatic re-attach after a close, exhaustion on the
// second consecutive failure, and dispose/revive (StrictMode) semantics.

import { afterEach, describe, expect, test, vi } from "vitest";

import { PanelConnection, type PanelClientLike } from "./panelConnection";

interface EventLog {
  attached: number;
  detached: number;
  failures: Array<{ error: string; exhausted: boolean }>;
}

function harness(script: Array<"ok" | "fail">) {
  const log: EventLog = { attached: 0, detached: 0, failures: [] };
  const closers: Array<(value: unknown) => void> = [];
  const rejecters: Array<(reason: unknown) => void> = [];
  let call = 0;
  const connection = new PanelConnection(
    {
      connect: () => {
        const outcome = script[Math.min(call, script.length - 1)];
        call += 1;
        if (outcome === "fail")
          return Promise.reject(new Error(`dial-${call}`));
        let close!: (value: unknown) => void;
        const closed = new Promise((resolve, reject) => {
          close = resolve;
          rejecters.push(reject);
        });
        closers.push(close);
        return Promise.resolve({ closed } satisfies PanelClientLike);
      },
    },
    {
      onAttached: () => {
        log.attached += 1;
      },
      onDetached: () => {
        log.detached += 1;
      },
      onFailed: (error, exhausted) => {
        log.failures.push({ error, exhausted });
      },
    },
  );
  return { connection, log, closers, rejecters, calls: () => call };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const flushMicrotasks = () => Promise.resolve();

afterEach(() => {
  vi.useRealTimers();
});

describe("PanelConnection", () => {
  test("attach succeeds and reports attached once", async () => {
    const h = harness(["ok"]);
    expect(await h.connection.attach()).toBe(true);
    expect(h.log.attached).toBe(1);
    expect(h.log.failures).toHaveLength(0);
  });

  test("single-flight: concurrent attaches dial once", async () => {
    const h = harness(["ok"]);
    const [first, second] = await Promise.all([
      h.connection.attach(),
      h.connection.attach(),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(h.calls()).toBe(1);
  });

  test("close triggers one automatic re-attach", async () => {
    const h = harness(["ok", "ok"]);
    await h.connection.attach();
    h.closers[0](undefined); // connection dies
    await tick();
    expect(h.log.detached).toBe(1);
    expect(h.log.attached).toBe(2); // recovered
    expect(h.log.failures).toHaveLength(0);
  });

  test("failed automatic recovery reports exhaustion", async () => {
    const h = harness(["ok", "fail"]);
    await h.connection.attach();
    h.closers[0](undefined);
    await tick();
    expect(h.log.detached).toBe(1);
    expect(h.log.failures).toEqual([
      { error: "Error: dial-2", exhausted: true },
    ]);
  });

  test("initial attach failure waits briefly before one automatic retry", async () => {
    vi.useFakeTimers();
    const h = harness(["fail", "fail"]);
    expect(await h.connection.attach()).toBe(false);
    expect(h.calls()).toBe(1);
    expect(h.log.failures).toEqual([
      { error: "Error: dial-1", exhausted: false },
    ]);

    await vi.advanceTimersByTimeAsync(749);
    expect(h.calls()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(h.calls()).toBe(2);
    expect(h.log.failures).toEqual([
      { error: "Error: dial-1", exhausted: false },
      { error: "Error: dial-2", exhausted: true },
    ]);
  });

  test("manual retry before delayed initial recovery prevents an extra automatic dial", async () => {
    vi.useFakeTimers();
    const h = harness(["fail", "ok", "fail"]);
    expect(await h.connection.attach()).toBe(false);
    expect(h.calls()).toBe(1);

    expect(await h.connection.attach()).toBe(true);
    expect(h.calls()).toBe(2);
    expect(h.log.attached).toBe(1);

    await vi.advanceTimersByTimeAsync(750);
    await flushMicrotasks();
    expect(h.calls()).toBe(2);
    expect(h.log.failures).toEqual([
      { error: "Error: dial-1", exhausted: false },
    ]);
  });

  test("manual retry after initial exhaustion redials and can recover", async () => {
    vi.useFakeTimers();
    const h = harness(["fail", "fail", "ok"]);
    expect(await h.connection.attach()).toBe(false);
    await vi.advanceTimersByTimeAsync(750);
    await flushMicrotasks();
    expect(h.log.failures.at(-1)?.exhausted).toBe(true);
    expect(await h.connection.attach()).toBe(true);
    expect(h.calls()).toBe(3);
    expect(h.log.attached).toBe(1);
  });

  test("StrictMode remount: attach bounced off an in-flight disposed dial redials", async () => {
    // Mount 1 dials (slow), cleanup disposes, mount 2 revives and
    // attaches into the single-flight guard. The stale dial's finally
    // must serve the bounced request — otherwise the panel sits
    // unattached until a manual retry.
    const h = harness(["ok", "ok"]);
    let resolveFirst!: (client: PanelClientLike) => void;
    const firstDial = new Promise<PanelClientLike>((resolve) => {
      resolveFirst = resolve;
    });
    let call = 0;
    const connection = new PanelConnection(
      {
        connect: () => {
          call += 1;
          if (call === 1) return firstDial;
          return Promise.resolve({ closed: new Promise(() => {}) });
        },
      },
      {
        onAttached: () => {
          h.log.attached += 1;
        },
        onDetached: () => {
          h.log.detached += 1;
        },
        onFailed: (error, exhausted) => {
          h.log.failures.push({ error, exhausted });
        },
      },
    );
    const first = connection.attach(); // mount 1
    connection.dispose(); // mount 1 cleanup
    connection.revive(); // mount 2
    const second = connection.attach(); // bounces off the guard
    expect(await second).toBe(false);
    resolveFirst({ closed: new Promise(() => {}) });
    expect(await first).toBe(false); // orphaned by the dispose
    await tick();
    expect(call).toBe(2); // the bounced request redialed
    expect(h.log.attached).toBe(1); // and attached
    expect(h.log.failures).toHaveLength(0);
  });

  test("second close after a successful recovery gets its own auto re-attach", async () => {
    // Pins "one auto attempt per CLOSE, reset on success" (review 8.2
    // edge 1) — a regression to once-per-process would fail here.
    const h = harness(["ok", "ok", "ok"]);
    await h.connection.attach();
    h.closers[0](undefined); // close #1
    await tick();
    expect(h.log.attached).toBe(2); // recovered
    h.closers[1](undefined); // close #2, after recovery
    await tick();
    expect(h.log.attached).toBe(3); // recovered again
    expect(h.log.detached).toBe(2);
    expect(h.log.failures).toHaveLength(0);
  });

  test("a REJECTING closed (socket error) triggers the same auto re-attach", async () => {
    // watchClosed must settle on the reject arm too (review 8.2 edge 2)
    // — sockets erroring is the likelier real-world death.
    const h = harness(["ok", "ok"]);
    await h.connection.attach();
    h.rejecters[0](new Error("socket died"));
    await tick();
    expect(h.log.detached).toBe(1);
    expect(h.log.attached).toBe(2); // recovered
    expect(h.log.failures).toHaveLength(0);
  });

  test("dispose orphans the closed watcher; revive allows re-attach", async () => {
    const h = harness(["ok", "ok"]);
    await h.connection.attach();
    h.connection.dispose();
    h.closers[0](undefined); // stale close after dispose
    await tick();
    expect(h.log.detached).toBe(0); // orphaned — no events, no redial
    expect(h.calls()).toBe(1);

    h.connection.revive();
    expect(await h.connection.attach()).toBe(true);
    expect(h.log.attached).toBe(2);
  });
});
