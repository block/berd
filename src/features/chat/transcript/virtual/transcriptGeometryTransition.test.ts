import { describe, expect, it } from "vitest";
import {
  transitionTranscriptGeometryViewport,
  type TranscriptGeometryViewportEvent,
  type TranscriptGeometryViewportState,
} from "./transcriptGeometryTransition";

const initial: TranscriptGeometryViewportState = {
  observedScrollTop: 100,
  pendingScroll: null,
};

function apply(
  state: TranscriptGeometryViewportState,
  event: TranscriptGeometryViewportEvent,
) {
  return transitionTranscriptGeometryViewport(state, event);
}

describe("transitionTranscriptGeometryViewport", () => {
  it("is deterministic and does not make a proposal authoritative", () => {
    const event = {
      type: "propose",
      reason: "row-anchor",
      scrollTop: 450,
      maxScrollTop: 1000,
      epsilon: 1,
    } as const;
    expect(apply(initial, event)).toEqual(apply(initial, event));
    const transition = apply(initial, event);
    expect(transition.state.observedScrollTop).toBe(100);
    expect(transition.effect?.nextScrollTop).toBe(450);
  });

  it("emits no repeated unacknowledged effect", () => {
    const event = {
      type: "propose",
      reason: "bottom-anchor",
      scrollTop: 900,
      maxScrollTop: 900,
      epsilon: 1,
    } as const;
    const first = apply(initial, event);
    expect(apply(first.state, event).effect).toBeNull();
  });

  it("converges on browser clamp acknowledgement", () => {
    const proposed = apply(initial, {
      type: "propose",
      reason: "scroll-to-row",
      scrollTop: 4000,
      maxScrollTop: 4000,
      epsilon: 1,
    });
    const acknowledged = apply(proposed.state, {
      type: "observe",
      scrollTop: 1600,
      maxScrollTop: 1600,
    });
    expect(acknowledged.state).toEqual({
      observedScrollTop: 1600,
      pendingScroll: null,
    });
    expect(
      apply(acknowledged.state, {
        type: "propose",
        reason: "scroll-to-row",
        scrollTop: 1600,
        maxScrollTop: 1600,
        epsilon: 1,
      }).effect,
    ).toBeNull();
  });

  it("coalesces equivalent pending proposals across reasons and subpixels", () => {
    const first = apply(initial, {
      type: "propose",
      reason: "bottom-anchor",
      scrollTop: 450,
      maxScrollTop: 1000,
      epsilon: 1,
    });
    expect(
      apply(first.state, {
        type: "propose",
        reason: "row-anchor",
        scrollTop: 450.5,
        maxScrollTop: 1000,
        epsilon: 1,
      }).effect,
    ).toBeNull();
  });

  it("rejects invalid proposals instead of turning them into scroll-to-top", () => {
    const pending = apply(initial, {
      type: "propose",
      reason: "row-anchor",
      scrollTop: 450,
      maxScrollTop: 1000,
      epsilon: 1,
    }).state;
    expect(
      apply(pending, {
        type: "propose",
        reason: "row-anchor",
        scrollTop: Number.NaN,
        maxScrollTop: 1000,
        epsilon: 1,
      }),
    ).toEqual({ state: pending, effect: null });
  });

  it("normalizes invalid proposal epsilon", () => {
    for (const epsilon of [Number.NaN, -1]) {
      expect(
        apply(initial, {
          type: "propose",
          reason: "row-anchor",
          scrollTop: initial.observedScrollTop,
          maxScrollTop: 1000,
          epsilon,
        }).effect,
      ).toBeNull();
    }
  });

  it("always returns finite clamped proposals", () => {
    const values = [
      Number.NEGATIVE_INFINITY,
      -100,
      0,
      10,
      1000,
      Number.POSITIVE_INFINITY,
      Number.NaN,
    ];
    for (const observed of values) {
      for (const target of values) {
        const state = apply(initial, {
          type: "observe",
          scrollTop: observed,
          maxScrollTop: 500,
        }).state;
        const result = apply(state, {
          type: "propose",
          reason: "row-anchor",
          scrollTop: target,
          maxScrollTop: 500,
          epsilon: 0,
        });
        expect(Number.isFinite(result.state.observedScrollTop)).toBe(true);
        expect(result.state.observedScrollTop).toBeGreaterThanOrEqual(0);
        expect(result.state.observedScrollTop).toBeLessThanOrEqual(500);
        if (result.effect) {
          expect(Number.isFinite(result.effect.nextScrollTop)).toBe(true);
          expect(result.effect.nextScrollTop).toBeGreaterThanOrEqual(0);
          expect(result.effect.nextScrollTop).toBeLessThanOrEqual(500);
        }
      }
    }
  });
});
