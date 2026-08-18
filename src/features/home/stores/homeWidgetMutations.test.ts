import { describe, expect, it } from "vitest";
import type { LayoutConstraints } from "@/features/layout/api/layout";
import type { WidgetInstance } from "../widgets/types";
import {
  addWidgetMutation,
  cleanUpWidgetsMutation,
  moveWidgetMutation,
  resizeWidgetMutation,
  updateWidgetStateMutation,
} from "./homeWidgetMutations";

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

function clockWidget(overrides: Partial<WidgetInstance> = {}): WidgetInstance {
  return { id: "w1", type: "clock", x: 0, y: 0, z: 1, ...overrides };
}

describe("homeWidgetMutations", () => {
  it("adds widgets with snapped top-left coordinates clamped by layout center constraints", () => {
    const [widget] =
      addWidgetMutation([], {
        id: "00000000-0000-4000-8000-000000000001",
        type: "clock",
        x: -1000,
        y: 1000,
        bounds: CONSTRAINTS,
      }) ?? [];

    expect(widget).toMatchObject({
      id: "00000000-0000-4000-8000-000000000001",
      type: "clock",
      x: -198,
      y: 162,
    });
  });

  it("moves widgets with snapped top-left coordinates clamped by layout center constraints", () => {
    expect(
      moveWidgetMutation([clockWidget()], "w1", 1000, -1000, CONSTRAINTS),
    ).toEqual([clockWidget({ x: 162, y: -198 })]);
  });

  it("can preserve an exact fractional position for initial layout placement", () => {
    expect(
      moveWidgetMutation(
        [clockWidget({ width: 173, height: 173 })],
        "w1",
        533.5,
        -266.5,
        undefined,
        { snapToGrid: false },
      ),
    ).toEqual([clockWidget({ x: 533.5, y: -266.5, width: 173, height: 173 })]);
  });

  it("moves widgets and brings them to the front in one mutation", () => {
    const widgets = [
      clockWidget({ id: "front", z: 3 }),
      clockWidget({ id: "target" }),
      clockWidget({ id: "middle", z: 2 }),
    ];

    expect(
      moveWidgetMutation(widgets, "target", 49, 73, CONSTRAINTS, {
        bringToFront: true,
      }),
    ).toEqual([
      clockWidget({ id: "front", z: 2 }),
      clockWidget({ id: "target", x: 48, y: 72, z: 3 }),
      clockWidget({ id: "middle" }),
    ]);
  });

  it("skips no-op move-to-front mutations when position and z-order are unchanged", () => {
    const widgets = [
      clockWidget({ id: "back" }),
      clockWidget({ id: "front", x: 24, y: 24, z: 2 }),
    ];

    expect(
      moveWidgetMutation(widgets, "front", 24, 24, CONSTRAINTS, {
        bringToFront: true,
      }),
    ).toBeNull();
  });

  it("resizes widgets and clamps their position with layout center constraints", () => {
    expect(
      resizeWidgetMutation(
        [clockWidget({ x: 1000, y: 1000, width: 240, height: 240 })],
        "w1",
        360,
        360,
        CONSTRAINTS,
      ),
    ).toEqual([
      clockWidget({
        x: 60,
        y: 60,
        width: 360,
        height: 360,
      }),
    ]);
  });

  it("cleans up widgets into a catalog-sorted grid in one mutation", () => {
    const widgets: WidgetInstance[] = [
      clockWidget({ id: "agent", type: "agentPin", x: 500, y: 500, z: 7 }),
      clockWidget({ id: "clock", x: 0, y: 0, z: 1 }),
      clockWidget({ id: "chat", type: "chatPin", x: 1000, y: 500, z: 2 }),
      clockWidget({ id: "skill", type: "skillPin", x: 1000, y: 0, z: 3 }),
    ];

    expect(cleanUpWidgetsMutation(widgets)).toEqual([
      clockWidget({
        id: "agent",
        type: "agentPin",
        x: 312,
        y: 0,
        z: 2,
        width: 200,
        height: 220,
      }),
      clockWidget({
        id: "clock",
        x: 0,
        y: 0,
        z: 1,
        width: 156,
        height: 156,
      }),
      clockWidget({
        id: "chat",
        type: "chatPin",
        x: 672,
        y: 0,
        z: 3,
        width: 188,
        height: 80,
      }),
      clockWidget({
        id: "skill",
        type: "skillPin",
        x: 1008,
        y: 0,
        z: 4,
        width: 240,
        height: 56,
      }),
    ]);
  });

  it("uses resolved photo sizes when cleaning up to prevent overlap", () => {
    const widgets: WidgetInstance[] = [
      {
        id: "photo-tall",
        type: "photo",
        x: 0,
        y: 0,
        z: 1,
        width: 280,
        height: 700,
        state: { shape: "original", aspectRatio: 0.4 },
      },
      {
        id: "photo-circle",
        type: "photo",
        x: 500,
        y: 500,
        z: 2,
        width: 320,
        height: 320,
        state: { shape: "circle", aspectRatio: 4 / 3 },
      },
    ];

    const next = cleanUpWidgetsMutation(widgets);

    expect(next).toEqual([
      expect.objectContaining({
        id: "photo-tall",
        x: 0,
        y: 0,
        width: 280,
        height: 700,
      }),
      expect.objectContaining({
        id: "photo-circle",
        x: 0,
        y: 768,
        width: 320,
        height: 320,
      }),
    ]);
  });

  it("skips no-op cleanup mutations when widgets are already organized", () => {
    const widgets: WidgetInstance[] = [
      clockWidget({ id: "clock", x: 0, y: 0, z: 1, width: 156, height: 156 }),
      clockWidget({
        id: "agent",
        type: "agentPin",
        x: 312,
        y: 0,
        z: 2,
        width: 200,
        height: 220,
      }),
      clockWidget({
        id: "chat",
        type: "chatPin",
        x: 672,
        y: 0,
        z: 3,
        width: 188,
        height: 80,
      }),
      clockWidget({
        id: "skill",
        type: "skillPin",
        x: 1008,
        y: 0,
        z: 4,
        width: 240,
        height: 56,
      }),
    ];

    expect(cleanUpWidgetsMutation(widgets)).toBeNull();
  });
});

describe("updateWidgetStateMutation — photo shape resize", () => {
  it("preserves displayed width when an original photo becomes square", () => {
    const photo: WidgetInstance = {
      id: "photo-1",
      type: "photo",
      x: 20,
      y: 30,
      z: 1,
      width: 280,
      height: 280,
      state: { shape: "original", aspectRatio: 1 },
    };

    const next = updateWidgetStateMutation([photo], "photo-1", {
      shape: "square",
    });

    expect(next?.[0]).toMatchObject({
      x: 20,
      y: 30,
      width: 280,
      height: 280,
      state: { shape: "square" },
    });
  });

  it("preserves widths outside the previous square bounds when changing shape", () => {
    const photo: WidgetInstance = {
      id: "photo-1",
      type: "photo",
      x: 20,
      y: 30,
      z: 1,
      width: 900,
      height: 450,
      state: { shape: "original", aspectRatio: 2 },
    };

    const next = updateWidgetStateMutation([photo], "photo-1", {
      shape: "square",
    });

    expect(next?.[0]).toMatchObject({
      width: 900,
      height: 900,
    });
  });

  it("preserves width and recenters vertically when a landscape photo becomes square", () => {
    const photo: WidgetInstance = {
      id: "photo-1",
      type: "photo",
      x: 20,
      y: 30,
      z: 1,
      width: 320,
      height: 240,
      state: { shape: "original", aspectRatio: 4 / 3 },
    };

    const next = updateWidgetStateMutation([photo], "photo-1", {
      shape: "square",
    });

    expect(next?.[0]).toMatchObject({
      x: 20,
      y: -10,
      width: 320,
      height: 320,
    });
  });
});

describe("updateWidgetStateMutation — onboarding tour resize", () => {
  it("keeps Berdy's avatar in place when dismissing the welcome bubble", () => {
    const tour: WidgetInstance = {
      id: "tour",
      type: "onboardingTour",
      x: 120,
      y: 150,
      z: 1,
      width: 448,
      height: 180,
    };

    expect(
      updateWidgetStateMutation([tour], "tour", { welcomeDismissed: true }),
    ).toEqual([
      expect.objectContaining({
        x: 120,
        y: 160,
        width: 160,
        height: 160,
      }),
    ]);
  });

  it("keeps a resized Berdy avatar in place when dismissing the bubble", () => {
    const tour: WidgetInstance = {
      id: "tour",
      type: "onboardingTour",
      x: 120,
      y: 150,
      z: 1,
      width: 672,
      height: 270,
    };

    expect(
      updateWidgetStateMutation([tour], "tour", { welcomeDismissed: true }),
    ).toEqual([
      expect.objectContaining({
        x: 120,
        y: 205,
        width: 160,
        height: 160,
      }),
    ]);
  });
});

describe("updateWidgetStateMutation — clock mode resize", () => {
  const analogClock: WidgetInstance = {
    id: "c1",
    type: "clock",
    x: 0,
    y: 0,
    z: 1,
    width: 240,
    height: 240,
  };

  it("snaps to the digital profile size when toggled to digital", () => {
    const next = updateWidgetStateMutation([analogClock], "c1", {
      mode: "digital",
    });
    expect(next?.[0]).toMatchObject({
      width: 224,
      height: 88,
      state: { mode: "digital" },
    });
  });

  it("preserves the clock center when toggled to another size profile", () => {
    const next = updateWidgetStateMutation(
      [{ ...analogClock, x: 120, y: 150, width: 300, height: 300 }],
      "c1",
      { mode: "digital" },
    );

    expect(next?.[0]).toMatchObject({
      x: 158,
      y: 256,
      width: 224,
      height: 88,
    });
    expect((next?.[0]?.x ?? 0) + (next?.[0]?.width ?? 0) / 2).toBeCloseTo(270);
    expect((next?.[0]?.y ?? 0) + (next?.[0]?.height ?? 0) / 2).toBeCloseTo(300);
  });

  it("clamps a center-preserving toggle within layout bounds", () => {
    const next = updateWidgetStateMutation(
      [{ ...analogClock, x: 120, y: 120, width: 300, height: 300 }],
      "c1",
      { mode: "digital" },
      CONSTRAINTS,
    );

    expect(next?.[0]).toMatchObject({
      x: 128,
      y: 196,
      width: 224,
      height: 88,
    });
  });

  it("restores custom clock sizes stored under legacy profile keys", () => {
    const digitalWithLegacyMemory: WidgetInstance = {
      ...analogClock,
      width: 224,
      height: 88,
      state: {
        mode: "digital",
        __sizeByProfile: {
          "240x240": { width: 300, height: 300 },
        },
      },
    };

    const next = updateWidgetStateMutation([digitalWithLegacyMemory], "c1", {
      mode: "analog",
    });

    expect(next?.[0]).toMatchObject({ width: 300, height: 300 });
  });

  it("snaps back to the analog profile size when toggled to analog", () => {
    const digital: WidgetInstance = {
      ...analogClock,
      width: 224,
      height: 88,
      state: { mode: "digital" },
    };
    const next = updateWidgetStateMutation([digital], "c1", { mode: "analog" });
    expect(next?.[0]).toMatchObject({
      width: 156,
      height: 156,
      state: { mode: "analog" },
    });
  });

  it("does not resize when a non-profile state key changes", () => {
    const note: WidgetInstance = {
      id: "n1",
      type: "stickyNote",
      x: 0,
      y: 0,
      z: 1,
      width: 224,
      height: 196,
      state: { noteId: "a" },
    };
    const next = updateWidgetStateMutation([note], "n1", { noteId: "b" });
    expect(next?.[0]).toMatchObject({ width: 224, height: 196 });
  });

  it("remembers a custom size per mode across toggles", () => {
    // The user resized the analog face to 300x300.
    const resizedAnalog: WidgetInstance = {
      ...analogClock,
      width: 300,
      height: 300,
    };

    // First toggle to digital: no digital size remembered yet -> digital default.
    const toDigital = updateWidgetStateMutation([resizedAnalog], "c1", {
      mode: "digital",
    });
    expect(toDigital?.[0]).toMatchObject({ width: 224, height: 88 });

    // The user then resizes the digital readout (committed via resize mutation).
    const resizedDigital: WidgetInstance = {
      ...(toDigital?.[0] as WidgetInstance),
      width: 360,
      height: Math.round(360 * (104 / 264)),
    };

    // Toggle back to analog: restores the remembered 300x300, not the 240 default.
    const backToAnalog = updateWidgetStateMutation([resizedDigital], "c1", {
      mode: "analog",
    });
    expect(backToAnalog?.[0]).toMatchObject({ width: 300, height: 300 });

    // Toggle to digital again: restores the remembered ~360-wide digital size.
    const digitalAgain = updateWidgetStateMutation(
      [backToAnalog?.[0] as WidgetInstance],
      "c1",
      { mode: "digital" },
    );
    expect(digitalAgain?.[0]).toMatchObject({ width: 360 });
  });
});
