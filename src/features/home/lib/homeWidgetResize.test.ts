import { describe, expect, it } from "vitest";
import type { LayoutConstraints } from "@/features/layout/api/layout";
import type { WidgetInstance } from "../widgets/types";
import {
  resolveWidgetResize,
  resolveWidgetResizeFromOffset,
} from "./homeWidgetResize";

const CONSTRAINTS: LayoutConstraints = {
  minCenter: -120,
  maxCenter: 240,
  minSize: 1,
  maxSize: 10_000,
  minZoomBps: 1000,
  maxZoomBps: 20_000,
  maxTitleOverrideLength: 120,
  maxItems: 100,
};

describe("homeWidgetResize", () => {
  it("uses vertical drag as the dominant axis for aspect-locked widgets", () => {
    expect(
      resolveWidgetResizeFromOffset({
        instance: {
          id: "clock-1",
          type: "clock",
          x: 0,
          y: 0,
          z: 1,
          width: 240,
          height: 240,
        },
        offset: { x: 12, y: 72 },
        viewportZoom: 1,
        bounds: CONSTRAINTS,
      }),
    ).toMatchObject({
      width: 312,
      height: 312,
    });
  });

  it("returns the same clamped bounds for pointer previews and committed sizes", () => {
    const instance = {
      id: "clock-1",
      type: "clock",
      x: 1000,
      y: 1000,
      z: 1,
      width: 240,
      height: 240,
    };

    const preview = resolveWidgetResizeFromOffset({
      instance,
      offset: { x: 120, y: 120 },
      viewportZoom: 1,
      bounds: CONSTRAINTS,
    });

    expect(preview).toEqual(
      resolveWidgetResize({
        instance,
        requestedSize: { width: preview.width, height: preview.height },
        bounds: CONSTRAINTS,
      }),
    );
    expect(preview).toEqual({
      x: 60,
      y: 60,
      width: 360,
      height: 360,
    });
  });
});

describe("resolveWidgetResize — clock profiles", () => {
  const digitalClock: WidgetInstance = {
    id: "c1",
    type: "clock",
    x: 0,
    y: 0,
    z: 1,
    width: 264,
    height: 104,
    state: { mode: "digital" },
  };

  it("keeps the digital landscape aspect ratio when resizing", () => {
    const resolved = resolveWidgetResize({
      instance: digitalClock,
      requestedSize: { width: 360, height: 360 },
    });
    expect(resolved.width).toBe(360);
    expect(resolved.height).toBeCloseTo(360 * (88 / 224), 5);
  });
});
