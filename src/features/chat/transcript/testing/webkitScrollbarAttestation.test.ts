import { describe, expect, it } from "vitest";
import { analyzeWebkitScrollbarSamples } from "./webkitScrollbarAttestation";

describe("WebKit scrollbar attestation analysis", () => {
  it("counts range transitions, browser activity, app writes, and material reversals", () => {
    const analysis = analyzeWebkitScrollbarSamples(
      [
        {
          kind: "frame",
          scrollTop: 1000,
          scrollHeight: 9000,
          renderRange: "1:20",
        },
        {
          kind: "scroll",
          scrollTop: 5000,
          scrollHeight: 9000,
          renderRange: "21:40",
        },
        {
          kind: "mutation",
          scrollTop: 5000,
          scrollHeight: 9100,
          renderRange: "21:40",
        },
        {
          kind: "app-write",
          scrollTop: 4700,
          scrollHeight: 9100,
          renderRange: "41:60",
        },
      ],
      200,
    );

    expect(analysis).toEqual({
      distinctRanges: 3,
      rangeTransitions: 2,
      mutations: 1,
      appWrites: 1,
      largestInterEventGap: 0,
      materialReversals: 1,
    });
  });

  it("treats the threshold itself as non-material and measures scroll-event gaps only", () => {
    const analysis = analyzeWebkitScrollbarSamples(
      [
        {
          kind: "scroll",
          scrollTop: 1000,
          scrollHeight: 9000,
          renderRange: "1:20",
        },
        {
          kind: "frame",
          scrollTop: 800,
          scrollHeight: 9000,
          renderRange: "1:20",
        },
        {
          kind: "scroll",
          scrollTop: 4200,
          scrollHeight: 9000,
          renderRange: "21:40",
        },
      ],
      200,
    );

    expect(analysis.materialReversals).toBe(0);
    expect(analysis.largestInterEventGap).toBe(3200);
  });
});
