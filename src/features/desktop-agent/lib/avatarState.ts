// Ported from the prototype's lib/avatar/avatar_state.dart + avatar_state_controller.dart.
//
// The state is always DERIVED from independent facts, never transitioned
// imperatively — stale states cannot get stuck (berd-mobile spec rule:
// activity indicators clear from authoritative updates, not lingering local
// state).

export type AvatarState =
  | "idle" //       default: subtle breathing/blink loop
  | "hover" //      mouse over: perk up (slight scale)
  | "listening" //  popover open: attentive
  | "thinking" //   prompt sent, awaiting first chunk: faster loop
  | "responding" // chunks streaming: faster loop
  | "error"; //     disconnected: paused + desaturated

export type AvatarActivity = "none" | "thinking" | "responding";

export interface AvatarInputs {
  hovering: boolean;
  expanded: boolean;
  /** Optimistically true at startup so the avatar doesn't flash the error
   *  treatment before the first connection attempt resolves. */
  connected: boolean;
  activity: AvatarActivity;
  debugOverride?: AvatarState | null;
}

/**
 * Priority (highest wins): debugOverride > disconnected > activity >
 * expanded > hover > idle. Pure — the prototype's controller getter as a function.
 */
export function deriveAvatarState(inputs: AvatarInputs): AvatarState {
  if (inputs.debugOverride) return inputs.debugOverride;
  if (!inputs.connected) return "error";
  switch (inputs.activity) {
    case "thinking":
      return "thinking";
    case "responding":
      return "responding";
    case "none":
      return inputs.expanded ? "listening" : inputs.hovering ? "hover" : "idle";
  }
}

/** Playback treatment for a state. */
export function treatmentFor(state: AvatarState): {
  playbackRate: number;
  paused: boolean;
  desaturated: boolean;
  scale: number;
} {
  return {
    playbackRate: state === "thinking" || state === "responding" ? 1.6 : 1.0,
    paused: state === "error",
    desaturated: state === "error",
    scale: state === "hover" ? 1.025 : 1.0,
  };
}

/** Avatar chip shape. */
export type AvatarShape = "circle" | "roundedSquare";

export interface AvatarChoice {
  id: string;
  label: string;
  /** Path under the site root (public/), or a data: URI for agent
   *  avatars pulled from Berd's artifact catalog. */
  src: string;
  shape: AvatarShape;
  /** Bundled avatars are HEVC loops; agent avatars are static images.
   *  Static avatars ignore playbackRate/paused treatments (nothing to
   *  animate) but keep scale/desaturation. */
  kind: "video" | "image";
  /** Per-avatar render scale (default 1.0), applied to the CHIP only —
   *  panel frame, hit target, and perch geometry stay at full size. The
   *  Berd logo reads visually heavier than the gloopies at equal pixels
   *  (the Berd logo renders 30% smaller). */
  renderScale?: number;
}

/** The bundled default avatar (agent avatars resolve from Berd's avatar
 *  catalog at runtime — see useAgentAvatar). The Berd gloopy (gloopies-22,
 *  2026-08-13 avatar pack): the default identity lands on a character,
 *  not an icon (2026-08-19 decision, replacing the Berd logo chip). */
export const DEFAULT_AVATAR: AvatarChoice = {
  id: "berd-gloopy",
  label: "Berd",
  src: "/desktop-agent/gloopies-22.mp4",
  shape: "circle",
  kind: "video",
};

/** Chip corner radius: circle = size/2; rounded square = size * 0.23. */
export function cornerRadius(shape: AvatarShape, size: number): number {
  return shape === "circle" ? size / 2 : size * 0.23;
}
