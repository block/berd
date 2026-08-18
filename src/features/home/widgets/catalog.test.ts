import { describe, expect, it } from "vitest";
import { clampWidgetSizeForInstance, widgetSizeForInstance } from "./catalog";
import type { WidgetInstance } from "./types";

const baseClock: WidgetInstance = { id: "c1", type: "clock", x: 0, y: 0, z: 1 };

describe("photo size profiles", () => {
  it("preserves a wide photo's original aspect ratio", () => {
    const photo: WidgetInstance = {
      id: "photo-1",
      type: "photo",
      x: 0,
      y: 0,
      z: 1,
      state: { shape: "original", aspectRatio: 2.5 },
    };

    expect(widgetSizeForInstance(photo)).toEqual({ width: 280, height: 112 });
  });

  it("preserves a tall photo's original aspect ratio", () => {
    const photo: WidgetInstance = {
      id: "photo-1",
      type: "photo",
      x: 0,
      y: 0,
      z: 1,
      state: { shape: "original", aspectRatio: 0.4 },
    };

    expect(widgetSizeForInstance(photo)).toEqual({ width: 280, height: 700 });
  });

  it("keeps original proportions while resizing", () => {
    const photo: WidgetInstance = {
      id: "photo-1",
      type: "photo",
      x: 0,
      y: 0,
      z: 1,
      state: { shape: "original", aspectRatio: 2.5 },
    };

    expect(
      clampWidgetSizeForInstance(photo, { width: 500, height: 500 }),
    ).toEqual({ width: 500, height: 200 });
  });
});

describe("onboarding tour size profiles", () => {
  it("shrinks the frame to the avatar after the welcome bubble is dismissed", () => {
    const dismissedTour: WidgetInstance = {
      id: "tour-1",
      type: "onboardingTour",
      x: 0,
      y: 0,
      z: 1,
      width: 448,
      height: 180,
      state: { welcomeDismissed: true },
    };

    expect(widgetSizeForInstance(dismissedTour)).toEqual({
      width: 160,
      height: 160,
    });
  });
});

describe("clock size profiles", () => {
  it("uses the analog (square) profile by default", () => {
    expect(widgetSizeForInstance(baseClock)).toEqual({
      width: 156,
      height: 156,
    });
  });

  it("uses the digital (landscape) profile when mode is digital", () => {
    const digital = { ...baseClock, state: { mode: "digital" } };
    expect(widgetSizeForInstance(digital)).toEqual({
      width: 224,
      height: 88,
    });
  });

  it("clamps a digital resize to digital bounds and aspect ratio", () => {
    const digital = { ...baseClock, state: { mode: "digital" } };
    const clamped = clampWidgetSizeForInstance(digital, {
      width: 999,
      height: 999,
    });
    expect(clamped.width).toBe(396);
    expect(clamped.height).toBeCloseTo(155.57, 2); // 396 * 88/224
  });

  it("clamps an analog resize to the square aspect ratio", () => {
    const clamped = clampWidgetSizeForInstance(baseClock, {
      width: 300,
      height: 999,
    });
    expect(clamped.width).toBe(300);
    expect(clamped.height).toBe(300);
  });
});
