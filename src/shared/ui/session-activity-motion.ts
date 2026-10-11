export type SessionActivityState = "working" | "unread" | "idle";
export interface ActivityDot {
  x: number;
  y: number;
  radius: number;
}

const DOT_RADIUS = 1.55;
const UNREAD_RADIUS = 3.5;
const LOOP_MS = 2400;
const GATHER_MS = 600;
const RELEASE_MS = 400;

/** Two offset pairs trade places in opposite directions, without a group-wide pause. */
export function shufflePose(time: number): ActivityDot[] {
  return Array.from({ length: 4 }, (_, index) => {
    const pair = Math.floor(index / 2);
    const angle =
      (time / LOOP_MS) * Math.PI * 2 + (index % 2) * Math.PI + pair * 0.85;
    return {
      x: 4.5 * Math.cos(angle),
      y:
        (pair === 0 ? -3.4 : 3.4) +
        (pair === 0 ? 1 : -1) * 1.8 * Math.sin(angle),
      radius: DOT_RADIUS,
    };
  });
}

function restingPose(state: SessionActivityState): ActivityDot[] {
  if (state === "working") {
    return [
      [-3.5, -3.5],
      [3.5, -3.5],
      [3.5, 3.5],
      [-3.5, 3.5],
    ].map(([x, y]) => ({ x, y, radius: DOT_RADIUS }));
  }
  return Array.from({ length: 4 }, () => ({
    x: 0,
    y: 0,
    radius: state === "unread" ? UNREAD_RADIUS : 0,
  }));
}

const interpolate = (from: number, to: number, progress: number) =>
  from + (to - from) * progress;

/** Presentation only: never infers unread from a completed, failed, or cancelled run. */
export class SessionActivityMotion {
  pose: ActivityDot[];
  private state: SessionActivityState;
  private animated: boolean;
  private time = 0;
  private transition: {
    from: ActivityDot[];
    to: ActivityDot[];
    elapsed: number;
    duration: number;
  } | null = null;

  constructor(state: SessionActivityState, animated: boolean) {
    this.state = state;
    this.animated = animated;
    this.pose =
      state === "working" && animated ? shufflePose(0) : restingPose(state);
  }

  get moving() {
    return (
      this.animated && (this.state === "working" || this.transition !== null)
    );
  }

  setState(state: SessionActivityState, animated: boolean) {
    if (state === this.state && animated === this.animated) return;
    const previousState = this.state;
    this.state = state;
    this.animated = animated;
    if (!animated || state === "idle" || previousState === "idle") {
      this.transition = null;
      this.pose =
        state === "working" && animated
          ? shufflePose(this.time)
          : restingPose(state);
      return;
    }
    this.transition = {
      from: this.pose.map((dot) => ({ ...dot })),
      to: state === "working" ? shufflePose(this.time) : restingPose(state),
      elapsed: 0,
      duration: state === "unread" ? GATHER_MS : RELEASE_MS,
    };
  }

  step(delta: number) {
    if (!this.animated) return;
    if (this.transition) {
      const transition = this.transition;
      transition.elapsed += Math.max(0, delta);
      const progress = Math.min(1, transition.elapsed / transition.duration);
      const position = 1 - (1 - progress) ** 3;
      const radius = progress * progress * (3 - 2 * progress);
      this.pose = transition.from.map((dot, index) => ({
        x: interpolate(dot.x, transition.to[index].x, position),
        y: interpolate(dot.y, transition.to[index].y, position),
        radius: interpolate(dot.radius, transition.to[index].radius, radius),
      }));
      if (progress === 1) this.transition = null;
      return;
    }
    if (this.state === "working") {
      this.time = (this.time + Math.max(0, delta)) % LOOP_MS;
      this.pose = shufflePose(this.time);
    }
  }
}
