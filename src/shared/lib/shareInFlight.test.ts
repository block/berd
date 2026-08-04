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
  it("collapses a mount burst onto one in-flight request", async () => {
    const inFlight = deferred<string>();
    const fn = vi.fn(() => inFlight.promise);
    const shared = shareInFlight(fn);

    const first = shared();
    const second = shared();
    inFlight.resolve("only");

    await expect(first).resolves.toBe("only");
    await expect(second).resolves.toBe("only");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("fetches again once the shared request has settled", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");
    const shared = shareInFlight(fn);

    await expect(shared()).resolves.toBe("first");
    await expect(shared()).resolves.toBe("second");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("bypasses a pre-write read in flight when a caller asks for fresh", async () => {
    const preWrite = deferred<string>();
    const postWrite = deferred<string>();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(preWrite.promise)
      .mockReturnValueOnce(postWrite.promise);
    const shared = shareInFlight(fn);

    // A sibling surface's read is still running (started before the write).
    const stale = shared();
    // The post-write refresh must not coalesce onto that pre-write read.
    const fresh = shared({ fresh: true });

    // Even if the stale read resolves last, the fresh read reflects its own
    // post-write fetch.
    postWrite.resolve("after");
    preWrite.resolve("before");

    await expect(fresh).resolves.toBe("after");
    await expect(stale).resolves.toBe("before");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("keeps sharing after a fresh request supersedes the slot", async () => {
    const preWrite = deferred<string>();
    const postWrite = deferred<string>();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(preWrite.promise)
      .mockReturnValueOnce(postWrite.promise);
    const shared = shareInFlight(fn);

    shared();
    const fresh = shared({ fresh: true });
    // The superseded pre-write request settling must not null out the slot that
    // now points at the fresh request; a plain caller still joins the fresh one.
    preWrite.resolve("before");
    await Promise.resolve();
    const joiner = shared();

    postWrite.resolve("after");
    await expect(fresh).resolves.toBe("after");
    await expect(joiner).resolves.toBe("after");
    // Only the mount read and the fresh read fetched; the joiner reused fresh.
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
