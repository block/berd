export type BerdyPose = "idle" | "dangle" | "sit";

export type BerdyClipKey =
  | "idle1"
  | "idle2"
  | "idle3"
  | "idle4"
  | "idleToDangle"
  | "dangleLoop"
  | "dangleToIdle"
  | "dangleToSit"
  | "sitToDangle"
  | "sitIdle1"
  | "sitIdle2"
  | "sitIdle3";

export interface BerdyClip {
  key: BerdyClipKey;
  file: string;
  from: BerdyPose;
  to: BerdyPose;
}

const ASSET_DIR = "/desktop-agent/berdy/";

export const BERDY_CLIPS: Record<BerdyClipKey, BerdyClip> = {
  idle1: {
    key: "idle1",
    file: `${ASSET_DIR}berdy_Idle_01_00001_.mp4`,
    from: "idle",
    to: "idle",
  },
  idle2: {
    key: "idle2",
    file: `${ASSET_DIR}berdy_Idle_02_00001_.mp4`,
    from: "idle",
    to: "idle",
  },
  idle3: {
    key: "idle3",
    file: `${ASSET_DIR}berdy_Idle_03_00001_.mp4`,
    from: "idle",
    to: "idle",
  },
  idle4: {
    key: "idle4",
    file: `${ASSET_DIR}berdy_Idle_04_00001_.mp4`,
    from: "idle",
    to: "idle",
  },
  idleToDangle: {
    key: "idleToDangle",
    file: `${ASSET_DIR}berdy_IdleToDangle_00001_.mp4`,
    from: "idle",
    to: "dangle",
  },
  dangleLoop: {
    key: "dangleLoop",
    file: `${ASSET_DIR}berdy_DangleToDangle_00001_.mp4`,
    from: "dangle",
    to: "dangle",
  },
  dangleToIdle: {
    key: "dangleToIdle",
    file: `${ASSET_DIR}berdy_DangleToIdle_00001_.mp4`,
    from: "dangle",
    to: "idle",
  },
  dangleToSit: {
    key: "dangleToSit",
    file: `${ASSET_DIR}berdy_DangleToSit_00001_.mp4`,
    from: "dangle",
    to: "sit",
  },
  sitToDangle: {
    key: "sitToDangle",
    file: `${ASSET_DIR}berdy_SitToDangle_00001_.mp4`,
    from: "sit",
    to: "dangle",
  },
  sitIdle1: {
    key: "sitIdle1",
    file: `${ASSET_DIR}berdy_Sit_Idle_01_00001_.mp4`,
    from: "sit",
    to: "sit",
  },
  sitIdle2: {
    key: "sitIdle2",
    file: `${ASSET_DIR}berdy_Sit_Idle_02_00001_.mp4`,
    from: "sit",
    to: "sit",
  },
  sitIdle3: {
    key: "sitIdle3",
    file: `${ASSET_DIR}berdy_Sit_Idle_03_00001_.mp4`,
    from: "sit",
    to: "sit",
  },
};

export const IDLE_CLIPS = ["idle1", "idle2", "idle3", "idle4"] as const;
export const SIT_CLIPS = ["sitIdle1", "sitIdle2", "sitIdle3"] as const;

export const ANCHOR = {
  idleFootY: 374 / 400,
  sitButtY: 0.74,
  grabX: 0.4875,
  grabY: 0.125,
} as const;

export const SPEED = {
  base: 1.3,
  hurry: 3.0,
  hurryTransitions: true,
} as const;

/** Media clocks are losslessly pre-timed 1.5x (36fps instead of 24fps).
 * Divide source-space rates by this factor to preserve product timing while
 * keeping native playback <=2x: WK otherwise drops to keyframes at hurry.
 * All samples/alpha/end poses are unchanged; see scripts/retime-berdy-media.py.
 */
export const BERDY_MEDIA_TIME_SCALE = 1.5;

export function playbackRateFor(
  clip: BerdyClip,
  target: BerdyPose,
  speed: typeof SPEED = SPEED,
) {
  const onTarget = clip.to === target;
  const atRest = onTarget && clip.from === clip.to;
  return atRest || (onTarget && !speed.hurryTransitions)
    ? speed.base
    : speed.hurry;
}

export interface LoopPicker {
  nextIdle(): BerdyClipKey;
  nextSit(): BerdyClipKey;
}

export function createLoopPicker(
  random = Math.random,
  randomIdle = true,
): LoopPicker {
  let idleIdx = -1;
  let sitIdx = -1;

  const pick = (clips: readonly BerdyClipKey[], lastIdx: number) => {
    if (!randomIdle) return (lastIdx + 1) % clips.length;
    if (clips.length <= 1) return 0;
    let next = Math.floor(random() * clips.length);
    if (next === lastIdx) next = (next + 1) % clips.length;
    return next;
  };

  return {
    nextIdle() {
      idleIdx = pick(IDLE_CLIPS, idleIdx);
      return IDLE_CLIPS[idleIdx];
    },
    nextSit() {
      sitIdx = pick(SIT_CLIPS, sitIdx);
      return SIT_CLIPS[sitIdx];
    },
  };
}

export function nextClipFor(
  state: BerdyPose,
  target: BerdyPose,
  picker: LoopPicker,
): BerdyClipKey {
  if (state === "idle") {
    return target === "idle" ? picker.nextIdle() : "idleToDangle";
  }
  if (state === "dangle") {
    if (target === "idle") return "dangleToIdle";
    if (target === "sit") return "dangleToSit";
    return "dangleLoop";
  }
  return target === "sit" ? picker.nextSit() : "sitToDangle";
}
