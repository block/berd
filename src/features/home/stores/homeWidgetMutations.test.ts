import { describe, expect, it } from "vitest";
import type { LayoutConstraints } from "@/features/layout/api/layout";
import type { WidgetInstance } from "../widgets/types";
import {
  addWidgetMutation,
  moveWidgetMutation,
  resizeWidgetMutation,
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
      x: -240,
      y: 120,
    });
  });

  it("moves widgets with snapped top-left coordinates clamped by layout center constraints", () => {
    expect(
      moveWidgetMutation([clockWidget()], "w1", 1000, -1000, CONSTRAINTS),
    ).toEqual([clockWidget({ x: 120, y: -240 })]);
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
});
