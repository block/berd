import { describe, expect, it } from "vitest";
import {
  clampToBounds,
  clampToLayoutConstraints,
  GRID_SIZE,
  isLayoutConstraints,
  snapPoint,
  snapTo,
} from "./snapToGrid";

const layoutConstraints = {
  minCenter: -100,
  maxCenter: 100,
  minSize: 1,
  maxSize: 1000,
  minZoomBps: 1000,
  maxZoomBps: 20_000,
  maxTitleOverrideLength: 120,
  maxItems: 100,
};

describe("GRID_SIZE", () => {
  it("is 24px (matches dot-grid spacing)", () => {
    expect(GRID_SIZE).toBe(24);
  });
});

describe("snapTo", () => {
  it.each([
    ["snaps 0 to 0", 0, undefined, 0],
    ["rounds 11 down below the default midpoint", 11, undefined, 0],
    ["rounds 12 up at the default midpoint", 12, undefined, 24],
    ["snaps 47 to 48", 47, undefined, 48],
    ["handles negative values", -13, undefined, -24],
    ["rounds 15 up on a custom grid", 15, 10, 20],
    ["rounds 14 down on a custom grid", 14, 10, 10],
  ] as const)("%s", (_name, value, gridSize, expected) => {
    expect(snapTo(value, gridSize)).toBe(expected);
  });
});

describe("snapPoint", () => {
  it("snaps both axes independently", () => {
    expect(snapPoint({ x: 11, y: 13 })).toEqual({ x: 0, y: 24 });
  });

  it("accepts a custom gridSize", () => {
    expect(snapPoint({ x: 7, y: 18 }, 10)).toEqual({ x: 10, y: 20 });
  });
});

describe("clampToBounds", () => {
  it("clamps negative x to 0", () => {
    expect(
      clampToBounds(
        { x: -50, y: 30 },
        { width: 100, height: 50 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ x: 0, y: 30 });
  });

  it("clamps x past the right edge to bounds.width - widgetSize.width", () => {
    expect(
      clampToBounds(
        { x: 1000, y: 30 },
        { width: 100, height: 50 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ x: 700, y: 30 });
  });

  it("clamps y past the bottom edge", () => {
    expect(
      clampToBounds(
        { x: 30, y: 1000 },
        { width: 100, height: 50 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ x: 30, y: 550 });
  });

  it("returns 0 when the widget is larger than the bounds", () => {
    expect(
      clampToBounds(
        { x: 100, y: 100 },
        { width: 1000, height: 800 },
        { width: 200, height: 200 },
      ),
    ).toEqual({ x: 0, y: 0 });
  });

  it("leaves an in-bounds point unchanged", () => {
    expect(
      clampToBounds(
        { x: 100, y: 100 },
        { width: 50, height: 50 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ x: 100, y: 100 });
  });
});

describe("isLayoutConstraints", () => {
  it("recognizes layout constraints and rejects viewport bounds", () => {
    expect(isLayoutConstraints(layoutConstraints)).toBe(true);
    expect(isLayoutConstraints({ width: 800, height: 600 })).toBe(false);
  });

  it.each([
    ["minCenter", Number.NaN],
    ["maxCenter", Number.POSITIVE_INFINITY],
    ["minZoomBps", Number.NEGATIVE_INFINITY],
    ["maxZoomBps", "20_000"],
  ] as const)("rejects malformed %s", (key, value) => {
    expect(isLayoutConstraints({ ...layoutConstraints, [key]: value })).toBe(
      false,
    );
  });
});

describe("clampToLayoutConstraints", () => {
  const constraints = {
    ...layoutConstraints,
    minCenter: -120,
    maxCenter: 240,
  };

  it("clamps top-left coordinates from center constraints and widget size", () => {
    expect(
      clampToLayoutConstraints(
        { x: -500, y: 500 },
        { width: 80, height: 120 },
        constraints,
      ),
    ).toEqual({ x: -160, y: 180 });
  });

  it("leaves a point whose widget center is within constraints unchanged", () => {
    expect(
      clampToLayoutConstraints(
        { x: 24, y: 48 },
        { width: 80, height: 120 },
        constraints,
      ),
    ).toEqual({ x: 24, y: 48 });
  });
});
