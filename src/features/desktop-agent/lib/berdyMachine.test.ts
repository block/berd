import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BERDY_CLIPS,
  BERDY_MEDIA_TIME_SCALE,
  createLoopPicker,
  nextClipFor,
  playbackRateFor,
  type BerdyPose,
} from "@/features/desktop-agent/lib/berdyClips";
import { BerdyMachine } from "@/features/desktop-agent/lib/berdyMachine";

class Video extends EventTarget {
  private time = 0;
  get currentTime() {
    return this.time;
  }
  set currentTime(value: number) {
    this.time = value;
    this.ended = false;
  }
  duration = 5.083984375 / BERDY_MEDIA_TIME_SCALE;
  playbackRate = 1;
  paused = true;
  ended = false;
  error = null;
  muted = false;
  playsInline = false;
  preload = "";
  src = "";
  videoWidth = 400;
  readyState = 2;
  seeking = false;
  callbacks = new Map<number, VideoFrameRequestCallback>();
  next = 0;
  load = vi.fn();
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  removeAttribute = vi.fn();
  requestVideoFrameCallback(cb: VideoFrameRequestCallback) {
    this.callbacks.set(++this.next, cb);
    return this.next;
  }
  cancelVideoFrameCallback(id: number) {
    this.callbacks.delete(id);
  }
  frame() {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const cb of callbacks) cb(0, {} as VideoFrameCallbackMetadata);
  }
  end() {
    this.ended = true;
    this.dispatchEvent(new Event("ended"));
  }
}

function fixture() {
  const videos: Video[] = [];
  const drawImage = vi.fn();
  const clearRect = vi.fn();
  const context = {
    drawImage,
    clearRect,
    globalCompositeOperation: "source-over",
  };
  const canvas = {
    width: 400,
    height: 400,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  const ready = vi.fn();
  const machine = new BerdyMachine({
    canvas,
    random: () => 0,
    onReady: ready,
    createVideo: () => {
      const video = new Video();
      videos.push(video);
      return video as unknown as HTMLVideoElement;
    },
  });
  return { machine, videos, drawImage, clearRect, ready, context };
}

describe("frozen clip graph", () => {
  it("routes every state/target pair and preserves legal two-hop edges", () => {
    const picker = createLoopPicker(() => 0);
    const poses: BerdyPose[] = ["idle", "dangle", "sit"];
    const expected = [
      ["idle1", "idleToDangle", "idleToDangle"],
      ["dangleToIdle", "dangleLoop", "dangleToSit"],
      ["sitToDangle", "sitToDangle", "sitIdle1"],
    ];
    poses.forEach((from, i) => {
      poses.forEach((target, j) => {
        const key = nextClipFor(from, target, picker);
        expect(key).toBe(expected[i][j]);
        expect(BERDY_CLIPS[key].from).toBe(from);
      });
    });
  });
  it("uses 1.3 only at rest on target; every other combination hurries at 3", () => {
    for (const clip of Object.values(BERDY_CLIPS)) {
      for (const target of ["idle", "dangle", "sit"] as const) {
        expect(playbackRateFor(clip, target)).toBe(
          clip.from === target && clip.to === target ? 1.3 : 3,
        );
      }
    }
  });
  it("preserves source-space duration at both speeds with native rates <=2", () => {
    const sourceDuration = 5.083984375;
    const mediaDuration = sourceDuration / BERDY_MEDIA_TIME_SCALE;
    for (const clip of Object.values(BERDY_CLIPS)) {
      for (const target of ["idle", "dangle", "sit"] as const) {
        const effectiveRate = playbackRateFor(clip, target);
        const nativeRate = effectiveRate / BERDY_MEDIA_TIME_SCALE;
        expect(nativeRate).toBeLessThanOrEqual(2);
        expect(mediaDuration / nativeRate).toBeCloseTo(
          sourceDuration / effectiveRate,
          12,
        );
      }
    }
  });
  it("never immediately repeats idle or seated loops", () => {
    const picker = createLoopPicker(() => 0);
    let idle = picker.nextIdle();
    let sit = picker.nextSit();
    for (let i = 0; i < 50; i++) {
      const nextIdle = picker.nextIdle();
      const nextSit = picker.nextSit();
      expect(nextIdle).not.toBe(idle);
      expect(nextSit).not.toBe(sit);
      idle = nextIdle;
      sit = nextSit;
    }
  });
});

describe("Berdy controller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("clears old alpha pixels immediately before each drawable frame, never while unavailable", async () => {
    const { machine, videos, drawImage, clearRect, context } = fixture();
    machine.start();
    await vi.advanceTimersByTimeAsync(7200);
    const idle = videos[0];
    const operations: string[] = [];
    clearRect.mockImplementation(() => operations.push("clear"));
    drawImage.mockImplementation(() => {
      expect(context.globalCompositeOperation).toBe("source-over");
      operations.push("draw");
    });
    idle.frame();
    idle.frame();
    expect(operations).toEqual(["clear", "draw", "clear", "draw"]);
    expect(clearRect).toHaveBeenNthCalledWith(1, 0, 0, 400, 400);
    expect(clearRect).toHaveBeenNthCalledWith(2, 0, 0, 400, 400);
    idle.readyState = 1;
    idle.frame();
    idle.readyState = 2;
    idle.seeking = true;
    idle.frame();
    idle.seeking = false;
    idle.videoWidth = 0;
    idle.frame();
    expect(clearRect).toHaveBeenCalledTimes(2);
    expect(drawImage).toHaveBeenCalledTimes(2);
    machine.suspend();
    expect(clearRect).toHaveBeenCalledTimes(2);
    machine.dispose();
  });
  it("interrupts steady loops immediately, keeps in-flight edges coherent and routes the latest target", async () => {
    const { machine, videos, ready, drawImage, clearRect } = fixture();
    machine.start();
    await vi.advanceTimersByTimeAsync(7200);
    const idle = videos[0];
    idle.frame();
    expect(ready).toHaveBeenCalledOnce();
    const staleFrame = [...idle.callbacks.values()][0];
    idle.currentTime = 2;
    machine.setTarget("dangle");
    expect(idle.paused).toBe(true);
    expect(idle.callbacks.size).toBe(0);
    expect(videos[4].paused).toBe(false);
    expect(videos[4].playbackRate).toBe(2);
    staleFrame(0, {} as VideoFrameCallbackMetadata);
    idle.end(); // old decoder's callbacks cannot route/draw over the new one
    expect(drawImage).toHaveBeenCalledOnce();
    videos[4].readyState = 1;
    videos[4].frame();
    expect(clearRect).toHaveBeenCalledOnce(); // keep last pixels until ready
    videos[4].currentTime = 0.75;
    const plays = videos[4].play.mock.calls.length;
    for (const target of ["idle", "sit", "dangle", "sit"] as const) {
      machine.setTarget(target);
      expect(videos[4].currentTime).toBe(0.75);
      expect(videos[4].play).toHaveBeenCalledTimes(plays);
    }
    videos[4].end();
    expect(videos[7].paused).toBe(false); // latest sit, never an idle hop
    videos[7].end();
    expect(videos[9].paused).toBe(false);
    expect(videos[9].playbackRate).toBe(1.3 / BERDY_MEDIA_TIME_SCALE);
    machine.setTarget("idle"); // seated loop interrupts via sit->dangle
    expect(videos[9].paused).toBe(true);
    expect(videos[8].paused).toBe(false);
    machine.setTarget("dangle");
    videos[8].end();
    expect(videos[5].paused).toBe(false);
    machine.setTarget("idle"); // dangle loop also interrupts immediately
    expect(videos[5].paused).toBe(true);
    expect(videos[6].paused).toBe(false);
    machine.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not restart unchanged targets or seek in-flight transitions, including suspend/resume", async () => {
    const { machine, videos } = fixture();
    machine.start();
    await vi.advanceTimersByTimeAsync(7200);
    const idle = videos[0];
    idle.currentTime = 1.25;
    const plays = idle.play.mock.calls.length;
    machine.setTarget("idle");
    expect(idle.currentTime).toBe(1.25);
    expect(idle.play).toHaveBeenCalledTimes(plays);
    machine.suspend();
    const totalPlays = videos.map((v) => v.play.mock.calls.length);
    machine.setTarget("sit");
    expect(videos.map((v) => v.play.mock.calls.length)).toEqual(totalPlays);
    machine.resume();
    expect(videos[4].paused).toBe(false); // don't resume the obsolete idle loop
    videos[4].currentTime = 1;
    machine.setTarget("idle");
    machine.suspend();
    machine.setTarget("dangle");
    machine.resume();
    expect(videos[4].currentTime).toBe(1);
    expect(videos[4].playbackRate).toBe(2);
    videos[4].end();
    expect(videos[5].paused).toBe(false);
    const danglePlays = videos[5].play.mock.calls.length;
    videos[5].currentTime = 0.5;
    machine.setTarget("dangle");
    expect(videos[5].currentTime).toBe(0.5);
    expect(videos[5].play).toHaveBeenCalledTimes(danglePlays);
    machine.dispose();
  });

  it("starts at the requested edge after warming rather than waiting for an idle loop", async () => {
    const { machine, videos } = fixture();
    machine.setTarget("sit");
    machine.start();
    await vi.advanceTimersByTimeAsync(7200);
    expect(videos[0].paused).toBe(true);
    expect(videos[4].paused).toBe(false);
    machine.dispose();
  });

  it("parks before startup and during warm-up; resumes and frees all callbacks/timers", async () => {
    const { machine, videos } = fixture();
    machine.suspend();
    machine.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(videos.every((v) => v.play.mock.calls.length === 0)).toBe(true);
    machine.resume();
    await vi.advanceTimersByTimeAsync(100);
    machine.suspend();
    await vi.advanceTimersByTimeAsync(1000);
    expect(videos.every((v) => v.paused && v.callbacks.size === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    machine.resume();
    await vi.advanceTimersByTimeAsync(7200);
    expect(videos[0].paused).toBe(false);
    machine.suspend();
    videos[0].ended = true;
    machine.setTarget("sit");
    machine.resume();
    expect(videos[4].paused).toBe(false);
    machine.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(videos.every((v) => v.callbacks.size === 0)).toBe(true);
  });
  it("recovers lost-ended and external pause; microseek cannot mask a permanent stall", async () => {
    const { machine, videos } = fixture();
    machine.start();
    await vi.advanceTimersByTimeAsync(7200);
    const idle = videos[0];
    idle.paused = true;
    await vi.advanceTimersByTimeAsync(700);
    expect(idle.paused).toBe(false);
    await vi.advanceTimersByTimeAsync(4500);
    expect(idle.load).toHaveBeenCalled();
    machine.setTarget("dangle");
    idle.ended = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(videos[4].paused).toBe(false);
    machine.dispose();
  });
  it.each([
    "idle",
    "sit",
  ] as const)("recovers when the %s picker re-enters a failed loop", async (pose) => {
    const { machine, videos, drawImage } = fixture();
    machine.start();
    await vi.advanceTimersByTimeAsync(7200);
    if (pose === "sit") {
      machine.setTarget("sit");
      videos[0].end();
      videos[4].end();
      videos[7].end();
    }
    const [first, second, third] = pose === "idle" ? videos : videos.slice(9);
    first.frame();
    first.dispatchEvent(new Event("error"));
    expect(second.paused).toBe(false);
    const failedPlays = first.play.mock.calls.length;
    // Deterministic random=0 repeatedly selects the failed first clip.
    let active = second;
    for (let i = 0; i < 4; i++) {
      active.ended = false;
      active.currentTime = 2;
      await vi.advanceTimersByTimeAsync(100);
      expect(active.currentTime).toBe(2); // healthy media is never cut
      const previous = active;
      active.end();
      expect(first.play).toHaveBeenCalledTimes(failedPlays);
      const next = videos.find((video) => !video.paused);
      expect(next).toBeDefined();
      if (!next) throw new Error("missing active decoder");
      active = next;
      expect(active).not.toBe(previous); // no repeats with healthy siblings
    }
    second.dispatchEvent(new Event("error"));
    expect(third.paused).toBe(false); // bounded scan, not a random retry loop
    third.frame();
    expect(drawImage).toHaveBeenCalledTimes(2);
    machine.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "watchdog",
    "resume",
  ])("parks on failed transitions without fabricating a destination; %s recovers on a new target", async (recovery) => {
    const { machine, videos, drawImage } = fixture();
    machine.start();
    await vi.advanceTimersByTimeAsync(7200);
    videos[0].frame();
    // An inactive decoder failure cannot cut the healthy active clip.
    videos[4].dispatchEvent(new Event("error"));
    machine.setTarget("sit");
    await vi.advanceTimersByTimeAsync(100);
    expect(videos[0].paused).toBe(true);
    videos[0].end();
    const plays = videos.map((video) => video.play.mock.calls.length);
    videos[4].end(); // a failed edge cannot signal a normal boundary
    await vi.advanceTimersByTimeAsync(2000);
    expect(videos.map((video) => video.play.mock.calls.length)).toEqual(plays);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(videos[7].paused).toBe(true); // idle->dangle never reached dangle
    if (recovery === "resume") machine.suspend();
    machine.setTarget("idle");
    if (recovery === "resume") machine.resume();
    else await vi.advanceTimersByTimeAsync(100);
    expect(videos[1].paused).toBe(false);
    machine.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("all-failed media stays bounded, retains pixels, and releases watchdog on hide/dispose", async () => {
    const { machine, videos, drawImage } = fixture();
    machine.start();
    await vi.advanceTimersByTimeAsync(7200);
    videos[0].frame();
    // Fail inactive clips first, then the active one.
    for (const video of [...videos.slice(1), videos[0]]) {
      video.dispatchEvent(new Event("error"));
    }
    const plays = videos.map((video) => video.play.mock.calls.length);
    for (const target of ["sit", "dangle", "idle"] as const) {
      machine.setTarget(target);
      await vi.advanceTimersByTimeAsync(10000);
    }
    expect(videos.map((video) => video.play.mock.calls.length)).toEqual(plays);
    expect(
      videos.every((video) => video.paused && video.callbacks.size === 0),
    ).toBe(true);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    machine.suspend();
    expect(vi.getTimerCount()).toBe(0);
    machine.resume();
    await vi.advanceTimersByTimeAsync(1000);
    expect(videos.map((video) => video.play.mock.calls.length)).toEqual(plays);
    machine.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposal during warm-up cannot start more decoders", async () => {
    const { machine, videos, ready } = fixture();
    machine.start();
    machine.dispose();
    await vi.advanceTimersByTimeAsync(10000);
    expect(videos.slice(1).every((v) => v.play.mock.calls.length === 0)).toBe(
      true,
    );
    expect(ready).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
