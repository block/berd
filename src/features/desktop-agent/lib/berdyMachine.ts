import {
  BERDY_CLIPS,
  BERDY_MEDIA_TIME_SCALE,
  createLoopPicker,
  nextClipFor,
  playbackRateFor,
  type BerdyClipKey,
  type BerdyPose,
} from "@/features/desktop-agent/lib/berdyClips";

export interface BerdyMachineOptions {
  canvas: HTMLCanvasElement;
  createVideo?: () => HTMLVideoElement;
  random?: () => number;
  onReady?: () => void;
}

/** Steady loops yield immediately to a new target; pose-changing clips finish.
 * Decoders stay off-DOM; the canvas retains its last frame across boundaries.
 */
export class BerdyMachine {
  private readonly context: CanvasRenderingContext2D;
  private readonly videos = new Map<BerdyClipKey, HTMLVideoElement>();
  private readonly picker;
  private active: BerdyClipKey | null = null;
  private target: BerdyPose = "idle";
  private suspended = false;
  private disposed = false;
  private started = false;
  private ready = false;
  private generation = 0;
  private endedCancel: (() => void) | null = null;
  private frameCancel: (() => void) | null = null;
  private watchdog: number | null = null;
  private warmCancel: (() => void) | null = null;
  private warming = false;
  private warmed = new Set<BerdyClipKey>();
  private failed = new Set<BerdyClipKey>();
  private lastTime = -1;
  private lastProgress = 0;
  private recovery = 0;
  private endedSince = 0;

  constructor(private readonly options: BerdyMachineOptions) {
    const context = options.canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Berdy canvas 2D context unavailable");
    this.context = context;
    this.picker = createLoopPicker(options.random);
    const create =
      options.createVideo ?? (() => document.createElement("video"));
    for (const clip of Object.values(BERDY_CLIPS)) {
      const video = create();
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.src = clip.file;
      video.addEventListener("error", this.onError);
      this.videos.set(clip.key, video);
    }
  }

  start() {
    if (this.started || this.disposed) return;
    this.started = true;
    void this.prepare();
  }

  setTarget(target: BerdyPose) {
    if (this.disposed || this.target === target) return;
    this.target = target;
    if (!this.suspended && this.interruptLoop()) return;
    this.applyRate();
  }

  suspend() {
    this.suspended = true;
    this.cancelDraw();
    this.stopWatchdog();
    this.warmCancel?.();
    for (const video of this.videos.values()) video.pause();
  }

  resume() {
    if (this.disposed) return;
    const wasSuspended = this.suspended;
    this.suspended = false;
    if (!this.started) return;
    if (!this.active) {
      void this.prepare();
      return;
    }
    if (!wasSuspended) return;
    const video = this.activeVideo();
    this.resetLiveness();
    if (this.failed.has(this.active)) this.recoverFailedClip();
    else if (this.interruptLoop()) {
      // Resume directly into the requested edge, not the old steady loop.
    } else if (video?.ended) this.advance();
    else {
      this.applyRate();
      this.play(video);
      this.drawLoop();
    }
    this.startWatchdog();
  }

  dispose() {
    this.disposed = true;
    this.suspend();
    for (const video of this.videos.values()) {
      video.removeEventListener("error", this.onError);
      video.removeAttribute("src");
      video.load();
    }
    this.videos.clear();
  }

  private async prepare() {
    if (this.warming || this.suspended || this.disposed) return;
    this.warming = true;
    for (const [key, video] of this.videos) {
      if (this.disposed || this.suspended) break;
      if (this.warmed.has(key)) continue;
      // play() fulfillment is not proof of a decoded frame. Bound first-frame
      // warm-up, and make cancellation release every timer/callback on hide.
      await new Promise<void>((resolve) => {
        let frame: number | undefined;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          if (frame !== undefined) video.cancelVideoFrameCallback?.(frame);
          video.pause();
          this.warmCancel = null;
          resolve();
        };
        const timer = window.setTimeout(finish, 600);
        this.warmCancel = finish;
        frame = video.requestVideoFrameCallback?.(finish);
        this.play(video);
      });
      if (!this.suspended && !this.disposed) this.warmed.add(key);
    }
    this.warming = false;
    if (this.disposed || this.suspended) return;
    // A hide→show during an awaited warm frame may have interrupted the loop.
    if (this.warmed.size !== this.videos.size) {
      void this.prepare();
      return;
    }
    this.playClip(nextClipFor("idle", this.target, this.picker));
    this.startWatchdog();
  }

  private play(video: HTMLVideoElement | null | undefined) {
    if (video && !this.disposed && !this.suspended)
      void video.play().catch(() => {});
  }

  private playClip(key: BerdyClipKey) {
    if (this.disposed || this.suspended) return;
    // A failed loop may have healthy siblings. Never skip a failed transition
    // to its destination: those pixels/that pose were never reached.
    if (this.failed.has(key)) {
      const failedClip = BERDY_CLIPS[key];
      const alternatives = Object.values(BERDY_CLIPS).filter(
        (clip) =>
          clip.from === failedClip.from &&
          clip.to === failedClip.to &&
          !this.failed.has(clip.key),
      );
      // Preserve no-repeat when at least two healthy sibling loops remain.
      key =
        (
          alternatives.find((clip) => clip.key !== this.active) ??
          alternatives[0]
        )?.key ?? key;
    }
    this.cancelDraw();
    this.activeVideo()?.pause();
    this.active = key;
    const video = this.activeVideo();
    if (!video) return;
    this.resetLiveness();
    // Park on an unavailable edge, retaining last good pixels. The watchdog
    // retries routing from its SOURCE so a changed target can still recover.
    if (this.failed.has(key)) return;
    try {
      video.currentTime = 0;
    } catch {
      /* metadata pending */
    }
    this.applyRate();
    this.drawLoop();
    this.play(video);
  }

  private interruptLoop() {
    if (!this.active) return false;
    const clip = BERDY_CLIPS[this.active];
    if (this.failed.has(this.active)) {
      this.recoverFailedClip();
      return true;
    }
    if (clip.from !== clip.to || clip.to === this.target) return false;
    this.playClip(nextClipFor(clip.to, this.target, this.picker));
    return true;
  }

  private applyRate() {
    const video = this.activeVideo();
    if (video && this.active)
      video.playbackRate =
        playbackRateFor(BERDY_CLIPS[this.active], this.target) /
        BERDY_MEDIA_TIME_SCALE;
  }

  private advance() {
    if (!this.active || this.disposed || this.suspended) return;
    this.playClip(
      nextClipFor(BERDY_CLIPS[this.active].to, this.target, this.picker),
    );
  }

  private recoverFailedClip() {
    if (!this.active) return;
    this.playClip(
      nextClipFor(BERDY_CLIPS[this.active].from, this.target, this.picker),
    );
  }

  private cancelDraw() {
    this.generation++;
    this.endedCancel?.();
    this.endedCancel = null;
    this.frameCancel?.();
    this.frameCancel = null;
  }

  private drawActiveVideo(video: HTMLVideoElement) {
    if (video.readyState < 2 || video.seeking || video.videoWidth <= 0) return;
    const { width, height } = this.options.canvas;
    // WKWebView's HEVC-alpha drawImage path can retain old silhouette pixels
    // with 'copy'. Clear explicitly, then paint in the same synchronous draw.
    this.context.clearRect(0, 0, width, height);
    this.context.globalCompositeOperation = "source-over";
    this.context.drawImage(video, 0, 0, width, height);
    if (!this.ready) {
      this.ready = true;
      this.options.onReady?.();
    }
  }

  private drawLoop() {
    this.cancelDraw();
    const token = this.generation;
    const video = this.activeVideo();
    if (!video) return;
    const ended = () => {
      // A removed listener/rVFC may already be queued. Also reject an old
      // ended event when this same decoder has since been rewound/reused.
      if (
        token === this.generation &&
        !this.disposed &&
        !this.suspended &&
        video.ended
      )
        this.advance();
    };
    video.addEventListener("ended", ended);
    this.endedCancel = () => video.removeEventListener("ended", ended);
    const schedule = () => {
      if (video.requestVideoFrameCallback) {
        const id = video.requestVideoFrameCallback(draw);
        this.frameCancel = () => video.cancelVideoFrameCallback(id);
      } else {
        const id = window.requestAnimationFrame(draw);
        this.frameCancel = () => window.cancelAnimationFrame(id);
      }
    };
    const draw = () => {
      if (this.disposed || this.suspended || token !== this.generation) return;
      this.drawActiveVideo(video);
      schedule();
    };
    schedule();
  }

  private activeVideo() {
    return this.active ? (this.videos.get(this.active) ?? null) : null;
  }
  private resetLiveness() {
    this.lastTime = -1;
    this.lastProgress = performance.now();
    this.recovery = 0;
    this.endedSince = 0;
  }
  private startWatchdog() {
    if (this.watchdog === null && !this.suspended)
      this.watchdog = window.setInterval(() => this.tick(), 100);
  }
  private stopWatchdog() {
    if (this.watchdog !== null) window.clearInterval(this.watchdog);
    this.watchdog = null;
  }
  private tick() {
    const video = this.activeVideo();
    if (!video || this.suspended || this.disposed) return;
    if (this.active && this.failed.has(this.active)) {
      // At most one routing attempt per tick; all-failed media cannot recurse
      // or fabricate an ended boundary. Healthy clips never enter this path.
      this.recoverFailedClip();
      return;
    }
    const now = performance.now();
    if (video.ended) {
      this.endedSince ||= now;
      if (now - this.endedSince >= 300) this.advance();
      return;
    }
    this.endedSince = 0;
    if (video.currentTime !== this.lastTime) {
      this.lastTime = video.currentTime;
      this.lastProgress = now;
      this.recovery = 0;
      return;
    }
    if (video.paused && now - this.lastProgress >= 500) this.play(video);
    if (now - this.lastProgress < 1500) return;
    this.lastProgress = now;
    this.recovery++;
    if (this.recovery < 3) {
      try {
        video.currentTime += 0.001;
        this.lastTime = video.currentTime;
      } catch {
        /* escalate */
      }
    } else {
      // Decoder recovery keeps the same clip/time,
      // retain the canvas, and reassert rate after load resets the decoder.
      const time = video.currentTime;
      video.load();
      try {
        video.currentTime = time;
      } catch {
        /* metadata pending */
      }
      this.applyRate();
      this.recovery = 0;
    }
    this.play(video);
  }
  private onError = (event: Event) => {
    for (const [key, video] of this.videos) {
      if (event.currentTarget === video) this.failed.add(key);
    }
    if (event.currentTarget === this.activeVideo()) this.recoverFailedClip();
  };
}
