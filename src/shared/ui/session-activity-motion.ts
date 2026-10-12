export type SessionActivityState = "working" | "unread" | "idle";
/** How the four working dots move. Every style gathers into the same unread dot. */
export type SessionActivityStyle = "bird" | "shuffle" | "beak";
export const SESSION_ACTIVITY_STYLES: readonly SessionActivityStyle[] = [
  "bird",
  "shuffle",
  "beak",
];
export const DEFAULT_SESSION_ACTIVITY_STYLE: SessionActivityStyle = "bird";

export interface ActivityDot {
  x: number;
  y: number;
  radius: number;
}

const TAU = Math.PI * 2;
const UNREAD_RADIUS = 3.5;
const GATHER_MS = 600;
const RELEASE_MS = 400;

export const SESSION_ACTIVITY_LOOP_MS: Record<SessionActivityStyle, number> = {
  bird: 5000,
  shuffle: 6000,
  beak: 8000,
};

// Asymmetric beat: a quicker downstroke and a softer recovery, never a hold.
const flap = (phase: number) => Math.sin(phase + 0.4 * Math.sin(phase));

/** A distant bird: four evenly spaced dots flap, with the wingtips trailing the shoulders. */
function birdPose(time: number): ActivityDot[] {
  const gap = 5;
  const theta = (time / SESSION_ACTIVITY_LOOP_MS.bird) * TAU;
  const bob = 0.6 * flap(theta + Math.PI);
  const innerY = bob - 1.4 * flap(theta);
  const tipPhase = theta - 0.9;
  const tipY = bob - 3.4 * flap(tipPhase);
  // A slight fore-aft sweep peaks at the turnarounds, so the wing never reads as stopped.
  const tipX =
    1.5 * gap - 0.2 * Math.abs(flap(tipPhase)) + 0.2 * Math.cos(tipPhase);
  const radius = 1.45;
  return [
    { x: -tipX, y: tipY, radius },
    { x: -gap / 2, y: innerY, radius },
    { x: gap / 2, y: innerY, radius },
    { x: tipX, y: tipY, radius },
  ];
}

/** Two offset pairs trade places in opposite directions, without a group-wide pause. */
function shufflePose(time: number): ActivityDot[] {
  return Array.from({ length: 4 }, (_, index) => {
    const pair = Math.floor(index / 2);
    const angle =
      (time / SESSION_ACTIVITY_LOOP_MS.shuffle) * TAU +
      (index % 2) * Math.PI +
      pair * 0.85;
    return {
      x: 4.5 * Math.cos(angle),
      y:
        (pair === 0 ? -3.4 : 3.4) +
        (pair === 0 ? 1 : -1) * 1.8 * Math.sin(angle),
      radius: 1.55,
    };
  });
}

/** A diamond that spins and breathes, echoing the Berd loader's beak. Speed never reaches zero. */
function beakPose(time: number): ActivityDot[] {
  const theta = (time / SESSION_ACTIVITY_LOOP_MS.beak) * TAU;
  const angle = theta + 0.3 * Math.sin(2 * theta);
  const radius = 4.2 + 0.36 * Math.sin(2 * theta);
  return Array.from({ length: 4 }, (_, index) => {
    const a = angle + (index * Math.PI) / 2 - Math.PI / 2;
    return { x: radius * Math.cos(a), y: radius * Math.sin(a), radius: 1.4 };
  });
}

export function activityPose(
  style: SessionActivityStyle,
  time: number,
): ActivityDot[] {
  if (style === "shuffle") return shufflePose(time);
  if (style === "beak") return beakPose(time);
  return birdPose(time);
}

/** Static working shape for reduced motion: distinct from the single unread dot. */
function stillWorkingPose(style: SessionActivityStyle): ActivityDot[] {
  if (style === "shuffle") {
    return [
      [-3.5, -3.5],
      [3.5, -3.5],
      [3.5, 3.5],
      [-3.5, 3.5],
    ].map(([x, y]) => ({ x, y, radius: 1.55 }));
  }
  // Bird: wings raised. Beak: the diamond.
  return activityPose(
    style,
    style === "bird" ? SESSION_ACTIVITY_LOOP_MS.bird / 4 : 0,
  );
}

function restingPose(
  style: SessionActivityStyle,
  state: SessionActivityState,
): ActivityDot[] {
  if (state === "working") return stillWorkingPose(style);
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
  private style: SessionActivityStyle;
  private time = 0;
  private transition: {
    from: ActivityDot[];
    to: ActivityDot[];
    elapsed: number;
    duration: number;
  } | null = null;

  constructor(
    state: SessionActivityState,
    animated: boolean,
    style: SessionActivityStyle = DEFAULT_SESSION_ACTIVITY_STYLE,
  ) {
    this.state = state;
    this.animated = animated;
    this.style = style;
    this.pose = this.target();
  }

  get moving() {
    return (
      this.animated && (this.state === "working" || this.transition !== null)
    );
  }

  private target() {
    return this.state === "working" && this.animated
      ? activityPose(this.style, this.time)
      : restingPose(this.style, this.state);
  }

  private transitionTo(duration: number) {
    this.transition = {
      from: this.pose.map((dot) => ({ ...dot })),
      to: this.target(),
      elapsed: 0,
      duration,
    };
  }

  setStyle(style: SessionActivityStyle) {
    if (style === this.style) return;
    this.style = style;
    this.time = 0;
    // Only visible working dots need to move into the new shape.
    if (this.animated && this.state === "working")
      this.transitionTo(RELEASE_MS);
    else if (this.state === "working") this.pose = this.target();
  }

  setState(state: SessionActivityState, animated: boolean) {
    if (state === this.state && animated === this.animated) return;
    const previousState = this.state;
    this.state = state;
    this.animated = animated;
    if (!animated || state === "idle" || previousState === "idle") {
      this.transition = null;
      this.pose = this.target();
      return;
    }
    // Gather from exactly what was painted.
    this.transitionTo(state === "unread" ? GATHER_MS : RELEASE_MS);
  }

  step(delta: number) {
    if (!this.animated) return;
    if (this.transition) {
      const transition = this.transition;
      transition.elapsed += Math.max(0, delta);
      const progress = Math.min(1, transition.elapsed / transition.duration);
      const position = 1 - (1 - progress) ** 3;
      const radius = progress * progress * (3 - 2 * progress);
      if (this.state === "working") {
        // Keep the beat running underneath so landing in the loop is seamless.
        this.advance(delta);
        transition.to = activityPose(this.style, this.time);
      }
      this.pose = transition.from.map((dot, index) => ({
        x: interpolate(dot.x, transition.to[index].x, position),
        y: interpolate(dot.y, transition.to[index].y, position),
        radius: interpolate(dot.radius, transition.to[index].radius, radius),
      }));
      if (progress === 1) this.transition = null;
      return;
    }
    if (this.state === "working") {
      this.advance(delta);
      this.pose = activityPose(this.style, this.time);
    }
  }

  private advance(delta: number) {
    this.time =
      (this.time + Math.max(0, delta)) % SESSION_ACTIVITY_LOOP_MS[this.style];
  }
}
