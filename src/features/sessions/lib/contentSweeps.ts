import type { QueryClient } from "@tanstack/react-query";
import {
  acpSearchSessions,
  type AcpSessionSearchSweep,
} from "@/shared/api/acp";
import {
  registerSessionSearchTargets,
  type SessionSearchPhase,
  type SessionSearchTarget,
} from "@/shared/api/sessionSearch";

/**
 * Raw-sweep coordination for session content search.
 *
 * Search surfaces (history, Cmd-K, the search page) share the local ACP
 * transport and SQLite pool, so page walks are serialized on one module-wide
 * queue: at most one un-interrupted `session/list` page is in flight at a
 * time, no matter how many hooks submit. Hooks submitting the same query join
 * one raw sweep with independent deadlines; the last waiter to detach aborts
 * the shared walk. The hook keeps the per-hook state (results, coverage,
 * stale gates); this module owns only the queue and the raw entries.
 */

/** The newest raw ACP sweep for a query, running or queued. */
type RawSweep = {
  query: string;
  controller: AbortController;
  promise: Promise<AcpSessionSearchSweep>;
  phase: SessionSearchPhase;
  phaseListeners: Set<(phase: SessionSearchPhase) => void>;
  targetStamps: Map<string, string>;
  waiters: Set<AbortController>;
  settled: boolean;
  retentionOwners: Map<ContentSweepOwner, ReturnType<typeof setTimeout>>;
};

type ContentSweepLease = {
  signal: AbortSignal;
  joined: boolean;
  corpusStampGeneration?: number;
  targetStamps: ReadonlyMap<string, string>;
  targets: readonly SessionSearchTarget[];
  targetIds: ReadonlySet<string>;
  attemptedTargetIds: ReadonlySet<string>;
  removedTargetIds: ReadonlySet<string>;
  /** The lease stays attached through caller-specific enrichment. */
  awaitSettlement: <T>(
    task: (sweep: AcpSessionSearchSweep) => Promise<T> | T,
  ) => Promise<T>;
};

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("The operation was aborted.", "AbortError")
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

/** Settles immediately when the logical caller is cancelled while leaving the
 * raw promise observed until it drains. */
export function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

type ScheduledServerSweep = {
  run: (releasePageSlot: () => void) => Promise<AcpSessionSearchSweep>;
  signal: AbortSignal;
  resolve: (sweep: AcpSessionSearchSweep) => void;
  reject: (error: unknown) => void;
  cancelWhileQueued: () => void;
};

const serverSweepQueue: ScheduledServerSweep[] = [];
const rawSweepsByQuery = new Map<string, RawSweep>();
let serverSweepRunning = false;

function runNextServerSweep(): void {
  if (serverSweepRunning) return;
  const next = serverSweepQueue.shift();
  if (!next) return;

  next.signal.removeEventListener("abort", next.cancelWhileQueued);
  if (next.signal.aborted) {
    next.reject(abortReason(next.signal));
    runNextServerSweep();
    return;
  }

  serverSweepRunning = true;
  let slotReleased = false;
  const releasePageSlot = () => {
    if (slotReleased) return;
    slotReleased = true;
    serverSweepRunning = false;
    runNextServerSweep();
  };

  let running: Promise<AcpSessionSearchSweep>;
  try {
    running = next.run(releasePageSlot);
  } catch (error) {
    next.reject(error);
    releasePageSlot();
    return;
  }
  void running.then(
    (sweep) => {
      next.resolve(sweep);
      releasePageSlot();
    },
    (error: unknown) => {
      next.reject(error);
      releasePageSlot();
    },
  );
}

function scheduleServerSweep(
  run: (releasePageSlot: () => void) => Promise<AcpSessionSearchSweep>,
  signal: AbortSignal,
): Promise<AcpSessionSearchSweep> {
  return new Promise((resolve, reject) => {
    const scheduled: ScheduledServerSweep = {
      run,
      signal,
      resolve,
      reject,
      cancelWhileQueued: () => {
        const index = serverSweepQueue.indexOf(scheduled);
        if (index < 0) return;
        serverSweepQueue.splice(index, 1);
        signal.removeEventListener("abort", scheduled.cancelWhileQueued);
        reject(abortReason(signal));
      },
    };
    signal.addEventListener("abort", scheduled.cancelWhileQueued, {
      once: true,
    });
    serverSweepQueue.push(scheduled);
    runNextServerSweep();
  });
}

interface ContentSweepOptions {
  queryClient?: QueryClient;
  onPhaseChange: (phase: SessionSearchPhase) => void;
  targetMode: "replace" | "append";
  timeoutMs: number;
  onDeadline: () => void;
}

/** Per-hook owner for leases on the renderer-wide raw-sweep coordinator. */
export class ContentSweepOwner {
  #current: RawSweep | null = null;
  #leases = new Map<AbortController, RawSweep>();
  #targetQuery = "";
  #targetsById = new Map<string, SessionSearchTarget>();
  #removedTargetIds = new Set<string>();

  static #clearRetention(rawSweep: RawSweep): void {
    for (const [owner, timeout] of rawSweep.retentionOwners) {
      clearTimeout(timeout);
      if (owner.#current === rawSweep) owner.#current = null;
    }
    rawSweep.retentionOwners.clear();
  }

  static #releaseRetentionOwner(
    rawSweep: RawSweep,
    owner: ContentSweepOwner,
  ): void {
    const timeout = rawSweep.retentionOwners.get(owner);
    if (timeout !== undefined) clearTimeout(timeout);
    rawSweep.retentionOwners.delete(owner);
  }

  reset(): void {
    this.abort();
    this.#targetQuery = "";
    this.#targetsById.clear();
    this.#removedTargetIds.clear();
  }

  abort(): void {
    for (const controller of this.#leases.keys()) controller.abort();
    const current = this.#current;
    if (current) {
      ContentSweepOwner.#releaseRetentionOwner(current, this);
      if (
        current.waiters.size === 0 &&
        !current.settled &&
        current.retentionOwners.size === 0
      ) {
        ContentSweepOwner.#clearRetention(current);
        current.controller.abort();
        if (rawSweepsByQuery.get(current.query) === current) {
          rawSweepsByQuery.delete(current.query);
        }
      }
    }
    this.#current = null;
  }

  acquire(
    trimmed: string,
    targets: SessionSearchTarget[],
    options: ContentSweepOptions,
  ): ContentSweepLease {
    const incomingTargets = new Map(
      targets.map((target) => [target.id, target]),
    );
    if (this.#targetQuery !== trimmed) {
      this.#targetQuery = trimmed;
      this.#targetsById = incomingTargets;
      this.#removedTargetIds.clear();
    } else if (options.targetMode === "replace") {
      for (const id of this.#targetsById.keys()) {
        if (!incomingTargets.has(id)) this.#removedTargetIds.add(id);
      }
      this.#targetsById = incomingTargets;
    } else {
      for (const [id, target] of incomingTargets) {
        this.#targetsById.set(id, target);
      }
    }
    for (const id of incomingTargets.keys()) this.#removedTargetIds.delete(id);
    const ownerTargets = [...this.#targetsById.values()];
    const targetIds = new Set(this.#targetsById.keys());
    const removedTargetIds = new Set(this.#removedTargetIds);
    const corpusStampGeneration = options.queryClient
      ? registerSessionSearchTargets(options.queryClient, ownerTargets)
      : undefined;

    const joinsCurrent =
      this.#current?.query === trimmed &&
      rawSweepsByQuery.get(trimmed) === this.#current &&
      !this.#current.controller.signal.aborted;
    if (!joinsCurrent) this.abort();

    const shared = rawSweepsByQuery.get(trimmed);
    const joined = Boolean(shared && !shared.controller.signal.aborted);
    let rawSweep: RawSweep;
    if (shared && !shared.controller.signal.aborted) {
      rawSweep = shared;
    } else {
      rawSweep = this.#createRawSweep(
        trimmed,
        targets,
        options.queryClient,
        corpusStampGeneration,
      );
    }
    ContentSweepOwner.#releaseRetentionOwner(rawSweep, this);
    this.#current = rawSweep;
    const attemptedTargetIds = new Set(
      joined ? targetIds : incomingTargets.keys(),
    );

    const logicalController = new AbortController();
    this.#leases.set(logicalController, rawSweep);
    rawSweep.waiters.add(logicalController);
    rawSweep.phaseListeners.add(options.onPhaseChange);
    options.onPhaseChange(rawSweep.phase);

    const onRawAbort = () =>
      logicalController.abort(abortReason(rawSweep.controller.signal));
    rawSweep.controller.signal.addEventListener("abort", onRawAbort, {
      once: true,
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      logicalController.abort(new Error("Session search timed out"));
      options.onDeadline();
    }, options.timeoutMs);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timeout);
      rawSweep.controller.signal.removeEventListener("abort", onRawAbort);
      rawSweep.phaseListeners.delete(options.onPhaseChange);
      rawSweep.waiters.delete(logicalController);
      this.#leases.delete(logicalController);

      const ownerStillWaiting = [...this.#leases.values()].includes(rawSweep);
      const retainForRetry =
        timedOut && rawSweep.phase === "reading" && !rawSweep.settled;
      const stopRawSweep = () => {
        rawSweep.controller.abort(abortReason(logicalController.signal));
        if (rawSweepsByQuery.get(rawSweep.query) === rawSweep) {
          rawSweepsByQuery.delete(rawSweep.query);
        }
      };
      if (retainForRetry) {
        ContentSweepOwner.#releaseRetentionOwner(rawSweep, this);
        const retentionTimeout = setTimeout(() => {
          rawSweep.retentionOwners.delete(this);
          if (this.#current === rawSweep && !ownerStillWaiting) {
            this.#current = null;
          }
          if (
            rawSweep.waiters.size === 0 &&
            rawSweep.retentionOwners.size === 0 &&
            !rawSweep.settled
          ) {
            stopRawSweep();
          }
        }, options.timeoutMs);
        rawSweep.retentionOwners.set(this, retentionTimeout);
      }
      if (this.#current === rawSweep && !ownerStillWaiting && !retainForRetry) {
        this.#current = null;
      }
      if (
        rawSweep.waiters.size === 0 &&
        !rawSweep.settled &&
        rawSweep.retentionOwners.size === 0
      ) {
        stopRawSweep();
      }
    };

    const promise = raceWithAbort(rawSweep.promise, logicalController.signal);
    return {
      signal: logicalController.signal,
      joined,
      corpusStampGeneration,
      targetStamps: rawSweep.targetStamps,
      targets: ownerTargets,
      targetIds,
      attemptedTargetIds,
      removedTargetIds,
      awaitSettlement: async <T>(
        task: (sweep: AcpSessionSearchSweep) => Promise<T> | T,
      ): Promise<T> => {
        try {
          return await task(await promise);
        } finally {
          release();
        }
      },
    };
  }

  #createRawSweep(
    trimmed: string,
    targets: SessionSearchTarget[],
    queryClient: QueryClient | undefined,
    corpusStampGeneration: number | undefined,
  ): RawSweep {
    const controller = new AbortController();
    let sweep: RawSweep | undefined;
    const run = (releasePageSlot: () => void) => {
      throwIfAborted(controller.signal);
      return acpSearchSessions(trimmed, targets, {
        queryClient,
        signal: controller.signal,
        corpusStampGeneration,
        onPhaseChange: (phase) => {
          if (phase === "reading") releasePageSlot();
          const notify = () => {
            if (!sweep || phase === sweep.phase) return;
            sweep.phase = phase;
            for (const listener of sweep.phaseListeners) listener(phase);
          };
          if (sweep) notify();
          else queueMicrotask(notify);
        },
      });
    };
    const promise = scheduleServerSweep(run, controller.signal);
    sweep = {
      query: trimmed,
      controller,
      promise,
      phase: "waiting",
      phaseListeners: new Set(),
      targetStamps: new Map(targets.map((target) => [target.id, target.stamp])),
      waiters: new Set(),
      settled: false,
      retentionOwners: new Map(),
    };
    rawSweepsByQuery.set(trimmed, sweep);

    const finish = () => {
      if (!sweep) return;
      sweep.settled = true;
      ContentSweepOwner.#clearRetention(sweep);
      if (rawSweepsByQuery.get(trimmed) === sweep) {
        rawSweepsByQuery.delete(trimmed);
      }
    };
    void promise.then(finish, finish);
    return sweep;
  }
}
