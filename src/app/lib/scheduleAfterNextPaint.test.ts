import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleAfterNextPaint } from "./scheduleAfterNextPaint";

function mockAnimationFrames() {
  let nextFrameId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const requestAnimationFrameSpy = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      callbacks.set(frameId, callback);
      return frameId;
    });
  const cancelAnimationFrameSpy = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation((frameId) => {
      callbacks.delete(frameId);
    });

  return {
    cancelAnimationFrameSpy,
    requestAnimationFrameSpy,
    runAll: () => {
      for (const [frameId, callback] of Array.from(callbacks)) {
        callbacks.delete(frameId);
        callback(performance.now());
      }
    },
  };
}

describe("scheduleAfterNextPaint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs after animation frame and a zero-delay timeout", () => {
    const frames = mockAnimationFrames();
    const callback = vi.fn();

    scheduleAfterNextPaint(callback);

    expect(callback).not.toHaveBeenCalled();
    expect(frames.requestAnimationFrameSpy).toHaveBeenCalledTimes(1);

    frames.runAll();
    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(0);
    expect(callback).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(120);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("uses the timeout fallback when animation frame does not run", () => {
    const frames = mockAnimationFrames();
    const callback = vi.fn();

    scheduleAfterNextPaint(callback);

    vi.advanceTimersByTime(119);
    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(frames.cancelAnimationFrameSpy).toHaveBeenCalledTimes(1);

    frames.runAll();
    vi.advanceTimersByTime(0);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("cancels before animation frame runs", () => {
    const frames = mockAnimationFrames();
    const callback = vi.fn();

    const cancel = scheduleAfterNextPaint(callback);
    cancel();

    frames.runAll();
    vi.advanceTimersByTime(120);

    expect(callback).not.toHaveBeenCalled();
    expect(frames.cancelAnimationFrameSpy).toHaveBeenCalledTimes(1);
  });

  it("cancels the post-frame timeout", () => {
    const frames = mockAnimationFrames();
    const callback = vi.fn();

    const cancel = scheduleAfterNextPaint(callback);
    frames.runAll();
    cancel();
    vi.advanceTimersByTime(120);

    expect(callback).not.toHaveBeenCalled();
  });
});
