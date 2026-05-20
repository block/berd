import { describe, expect, it } from "vitest";
import { clampToBounds, GRID_SIZE, snapPoint, snapTo } from "./snapToGrid";

describe("GRID_SIZE", () => {
  it("is 24px (matches dot-grid spacing)", () => {
    expect(GRID_SIZE).toBe(24);
  });
});

describe("snapTo", () => {
  it("snaps 0 to 0", () => {
    expect(snapTo(0)).toBe(0);
  });

  it("rounds 11 down to 0 (below midpoint of 24)", () => {
    expect(snapTo(11)).toBe(0);
  });

  it("rounds 12 up to 24 (Math.round half-up)", () => {
    expect(snapTo(12)).toBe(24);
  });

  it("snaps 47 to 48", () => {
    expect(snapTo(47)).toBe(48);
  });

  it("handles negative values", () => {
    expect(snapTo(-13)).toBe(-24);
  });

  it("accepts a custom gridSize", () => {
    expect(snapTo(15, 10)).toBe(20);
    expect(snapTo(14, 10)).toBe(10);
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
