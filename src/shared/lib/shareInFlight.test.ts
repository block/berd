import { describe, expect, it, vi } from "vitest";
import { shareInFlight } from "./shareInFlight";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("shareInFlight", () => {
  it("collapses a mount burst of coalescing callers onto one in-flight request", async () => {
    const inFlight = deferred<string>();
    const fn = vi.fn(() => inFlight.promise);
    const shared = shareInFlight(fn);

    const first = shared({ coalesce: true });
    const second = shared({ coalesce: true });
    inFlight.resolve("only");

    await expect(first).resolves.toBe("only");
    await expect(second).resolves.toBe("only");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("fetches again for a coalescing caller once the shared request has settled", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");
    const shared = shareInFlight(fn);

    await expect(shared({ coalesce: true })).resolves.toBe("first");
    await expect(shared({ coalesce: true })).resolves.toBe("second");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("starts a new request for a plain call while a read is in flight", async () => {
    const preWrite = deferred<string>();
    const postWrite = deferred<string>();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(preWrite.promise)
      .mockReturnValueOnce(postWrite.promise);
    const shared = shareInFlight(fn);

    // A sibling surface's read is still running (started before the write).
    const stale = shared({ coalesce: true });
    // A plain post-write read must not join it — no option required, which is
    // what keeps a caller who has never heard of `coalesce` correct.
    const fresh = shared();

    // Even if the stale read resolves last, the fresh read reflects its own
    // post-write fetch.
    postWrite.resolve("after");
    preWrite.resolve("before");

    await expect(fresh).resolves.toBe("after");
    await expect(stale).resolves.toBe("before");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("hands a later coalescing caller the post-write read, not the superseded one", async () => {
    const preWrite = deferred<string>();
    const postWrite = deferred<string>();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(preWrite.promise)
      .mockReturnValueOnce(postWrite.promise);
    const shared = shareInFlight(fn);

    shared({ coalesce: true });
    const fresh = shared();
    // The superseded pre-write request settling must not null out the slot that
    // now points at the plain request; a coalescing caller still joins it.
    preWrite.resolve("before");
    await Promise.resolve();
    const joiner = shared({ coalesce: true });

    postWrite.resolve("after");
    await expect(fresh).resolves.toBe("after");
    await expect(joiner).resolves.toBe("after");
    // Only the mount read and the post-write read fetched; the joiner reused
    // the post-write one.
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
