// Ported from the prototype's avatar_state_controller semantics: derivation priority
// debugOverride > disconnected > activity > expanded > hover > idle.

import { describe, expect, test } from "vitest";

import {
  deriveAvatarState,
  treatmentFor,
  type AvatarInputs,
} from "./avatarState";

const base: AvatarInputs = {
  hovering: false,
  expanded: false,
  connected: true,
  activity: "none",
};

describe("deriveAvatarState", () => {
  test("idle by default", () => {
    expect(deriveAvatarState(base)).toBe("idle");
  });

  test("hover when pointer over and nothing else going on", () => {
    expect(deriveAvatarState({ ...base, hovering: true })).toBe("hover");
  });

  test("listening when expanded beats hover", () => {
    expect(deriveAvatarState({ ...base, hovering: true, expanded: true })).toBe(
      "listening",
    );
  });

  test("activity beats expanded and hover", () => {
    expect(
      deriveAvatarState({
        ...base,
        hovering: true,
        expanded: true,
        activity: "thinking",
      }),
    ).toBe("thinking");
    expect(
      deriveAvatarState({ ...base, expanded: true, activity: "responding" }),
    ).toBe("responding");
  });

  test("disconnected beats everything except debug override", () => {
    expect(
      deriveAvatarState({
        ...base,
        connected: false,
        activity: "thinking",
        expanded: true,
      }),
    ).toBe("error");
  });

  test("debug override wins outright", () => {
    expect(
      deriveAvatarState({ ...base, connected: false, debugOverride: "hover" }),
    ).toBe("hover");
  });
});

describe("treatmentFor", () => {
  test("thinking and responding speed the loop up", () => {
    expect(treatmentFor("thinking").playbackRate).toBe(1.6);
    expect(treatmentFor("responding").playbackRate).toBe(1.6);
    expect(treatmentFor("idle").playbackRate).toBe(1.0);
  });

  test("error pauses and desaturates", () => {
    const t = treatmentFor("error");
    expect(t.paused).toBe(true);
    expect(t.desaturated).toBe(true);
  });

  test("hover scales 1.025 (fits inside the 90pt panel)", () => {
    expect(treatmentFor("hover").scale).toBe(1.025);
    expect(treatmentFor("idle").scale).toBe(1.0);
  });
});
