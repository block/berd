import { describe, expect, it } from "vitest";
import {
  reduceSessionTarget,
  type SessionTargetSyncState,
} from "./sessionTargetReducer";

const a = {
  harnessId: "goose",
  modelProviderId: "openai",
  modelId: "a",
  modelName: "A",
} as const;
const b = {
  harnessId: "goose",
  modelProviderId: "openai",
  modelId: "b",
  modelName: "B",
} as const;
const c = {
  harnessId: "goose",
  modelProviderId: "anthropic",
  modelId: "c",
  modelName: "C",
} as const;

describe("reduceSessionTarget", () => {
  it("keeps committed and desired targets distinct until acknowledgement", () => {
    const settled: SessionTargetSyncState = { status: "settled", committed: a };
    const transitioning = reduceSessionTarget(settled, {
      type: "SELECT",
      operationId: "b",
      origin: "picker",
      desired: b,
    });
    expect(transitioning).toMatchObject({
      status: "transitioning",
      previous: a,
      desired: b,
    });
    const committed = reduceSessionTarget(transitioning, {
      type: "ACKNOWLEDGED",
      operationId: "b",
      target: b,
    });
    expect(committed).toEqual({
      status: "settled",
      committed: b,
      metadata: undefined,
    });
  });

  it("makes selection latest-wins without allowing stale completion to commit", () => {
    const first = reduceSessionTarget(
      { status: "settled", committed: a },
      {
        type: "SELECT",
        operationId: "b",
        origin: "picker",
        desired: b,
      },
    );
    const latest = reduceSessionTarget(first, {
      type: "SELECT",
      operationId: "c",
      origin: "picker",
      desired: c,
    });
    expect(latest).toMatchObject({
      status: "transitioning",
      operationId: "c",
      previous: a,
      desired: c,
    });
    expect(
      reduceSessionTarget(latest, {
        type: "ACKNOWLEDGED",
        operationId: "b",
        target: b,
      }),
    ).toBe(latest);
  });

  it("retains the last acknowledged target on failure", () => {
    const transitioning = reduceSessionTarget(
      { status: "settled", committed: a },
      {
        type: "SELECT",
        operationId: "b",
        origin: "picker",
        desired: b,
      },
    );
    expect(
      reduceSessionTarget(transitioning, {
        type: "REJECTED",
        operationId: "b",
        error: new Error("no"),
      }),
    ).toMatchObject({
      status: "failed",
      desired: b,
      fallback: a,
      retryable: true,
    });
  });

  it("lets authoritative hydration supersede an active selection", () => {
    const transitioning = reduceSessionTarget(
      { status: "settled", committed: a },
      {
        type: "SELECT",
        operationId: "b",
        origin: "picker",
        desired: b,
      },
    );
    expect(
      reduceSessionTarget(transitioning, { type: "HYDRATE", target: c }),
    ).toEqual({
      status: "settled",
      committed: c,
      metadata: undefined,
    });
  });
});
