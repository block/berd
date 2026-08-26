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

describe("prompt pin size profiles", () => {
  const promptPin = (state?: Record<string, unknown>): WidgetInstance => ({
    id: "prompt-1",
    type: "promptPin",
    x: 0,
    y: 0,
    z: 1,
    state,
  });

  it("sizes the frame to the compact card in ready mode", () => {
    expect(widgetSizeForInstance(promptPin({ mode: "ready" }))).toEqual({
      width: 280,
      height: 52,
    });
  });

  it("gives the editor room in edit mode", () => {
    expect(widgetSizeForInstance(promptPin({ mode: "edit" }))).toEqual({
      width: 280,
      height: 170,
    });
  });

  it("opens a freshly picked pin in the editor profile", () => {
    expect(widgetSizeForInstance(promptPin())).toEqual({
      width: 280,
      height: 170,
    });
  });

  // Text is saved on a debounce while the editor is open. Sizing the frame
  // from saved text collapsed the pin to the one-row height on the first
  // keystroke, clipping the editor and stranding the edit.
  it("keeps the editor frame while a new pin's prompt is being typed", () => {
    expect(
      widgetSizeForInstance(promptPin({ title: "Greeting", text: "Hi" })),
    ).toEqual({ width: 280, height: 170 });
  });

  // Height is not a degree of freedom for a one-row card, so a vertical drag
  // is absorbed while the width still tracks the pointer.
  it("keeps the ready card at one row while staying width-resizable", () => {
    expect(
      clampWidgetSizeForInstance(promptPin({ mode: "ready" }), {
        width: 300,
        height: 170,
      }),
    ).toEqual({ width: 300, height: 52 });
  });

  // A pin already on the canvas carries a height from before the ready
  // profile existed, and toggling modes can launder that height into
  // per-profile size memory. Both reach the frame as a persisted height, so
  // the pinned height has to win or the leftover space reads as dead padding.
  it("collapses a height persisted before the ready profile existed", () => {
    expect(
      widgetSizeForInstance({
        ...promptPin({ mode: "ready" }),
        width: 280,
        height: 80,
      }),
    ).toEqual({ width: 280, height: 52 });
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

describe("sticky note size profiles", () => {
  it("uses a short wide profile for label tone", () => {
    const label: WidgetInstance = {
      id: "note-1",
      type: "label",
      x: 0,
      y: 0,
      z: 1,
    };

    expect(widgetSizeForInstance(label)).toEqual({ width: 280, height: 56 });
    expect(
      clampWidgetSizeForInstance(label, { width: 999, height: 999 }),
    ).toEqual({ width: 280, height: 56 });
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
