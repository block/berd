import { describe, expect, it } from "vitest";
import type { WidgetInstance, WidgetSize } from "../widgets/types";
import {
  hasVisibleHomeCanvasWidget,
  isHomeCanvasPointInsideViewport,
  isHomeCanvasWidgetVisible,
} from "./homeCanvasVisibility";

function widget(overrides: Partial<WidgetInstance> = {}): WidgetInstance {
  return {
    id: "widget-1",
    type: "clock",
    x: 100,
    y: 100,
    z: 1,
    width: 100,
    height: 100,
    ...overrides,
  };
}

const widgetSizeForInstance = (instance: WidgetInstance): WidgetSize => ({
  width: instance.width ?? 100,
  height: instance.height ?? 100,
});

describe("hasVisibleHomeCanvasWidget", () => {
  it("returns true when a widget is fully inside the visible viewport", () => {
    expect(
      hasVisibleHomeCanvasWidget({
        viewport: { x: 0, y: 0, zoom: 1 },
        viewportSize: { width: 800, height: 600 },
        instances: [widget()],
        widgetSizeForInstance,
      }),
    ).toBe(true);
  });

  it("returns true when a widget partially intersects the visible viewport", () => {
    expect(
      hasVisibleHomeCanvasWidget({
        viewport: { x: 0, y: 0, zoom: 1 },
        viewportSize: { width: 800, height: 600 },
        instances: [widget({ x: 760, y: 580 })],
        widgetSizeForInstance,
      }),
    ).toBe(true);
  });

  it("ignores widgets that only intersect the outer viewport inset", () => {
    expect(
      hasVisibleHomeCanvasWidget({
        viewport: { x: 0, y: 0, zoom: 1 },
        viewportSize: { width: 800, height: 600 },
        viewportInsetPx: 50,
        instances: [widget({ x: 760, y: 200 })],
        widgetSizeForInstance,
      }),
    ).toBe(false);

    expect(
      hasVisibleHomeCanvasWidget({
        viewport: { x: 0, y: 0, zoom: 1 },
        viewportSize: { width: 800, height: 600 },
        viewportInsetPx: 50,
        instances: [widget({ x: 740, y: 200 })],
        widgetSizeForInstance,
      }),
    ).toBe(true);
  });

  it("discounts the left viewport occlusion before applying the inset", () => {
    expect(
      hasVisibleHomeCanvasWidget({
        viewport: { x: 0, y: 0, zoom: 1 },
        viewportSize: { width: 800, height: 600 },
        viewportLeftOcclusionPx: 200,
        viewportInsetPx: 50,
        instances: [widget({ x: 210, y: 200, width: 30 })],
        widgetSizeForInstance,
      }),
    ).toBe(false);

    expect(
      hasVisibleHomeCanvasWidget({
        viewport: { x: 0, y: 0, zoom: 1 },
        viewportSize: { width: 800, height: 600 },
        viewportLeftOcclusionPx: 200,
        viewportInsetPx: 50,
        instances: [widget({ x: 260, y: 200, width: 30 })],
        widgetSizeForInstance,
      }),
    ).toBe(true);
  });

  it("returns false when every widget is fully outside the visible viewport", () => {
    expect(
      hasVisibleHomeCanvasWidget({
        viewport: { x: 0, y: 0, zoom: 1 },
        viewportSize: { width: 800, height: 600 },
        instances: [widget({ x: 801, y: 100 })],
        widgetSizeForInstance,
      }),
    ).toBe(false);
  });

  it("checks visibility for one widget", () => {
    expect(
      isHomeCanvasWidgetVisible({
        viewport: { x: 0, y: 0, zoom: 1 },
        viewportSize: { width: 800, height: 600 },
        instance: widget({ x: 100, y: 100 }),
        widgetSizeForInstance,
      }),
    ).toBe(true);

    expect(
      isHomeCanvasWidgetVisible({
        viewport: { x: 0, y: 0, zoom: 1 },
        viewportSize: { width: 800, height: 600 },
        instance: widget({ x: 801, y: 100 }),
        widgetSizeForInstance,
      }),
    ).toBe(false);
  });

  it("uses zoomed world bounds when checking visibility", () => {
    expect(
      hasVisibleHomeCanvasWidget({
        viewport: { x: 200, y: 100, zoom: 2 },
        viewportSize: { width: 800, height: 600 },
        instances: [widget({ x: 290, y: 240, width: 20, height: 20 })],
        widgetSizeForInstance,
      }),
    ).toBe(true);

    expect(
      hasVisibleHomeCanvasWidget({
        viewport: { x: 200, y: 100, zoom: 2 },
        viewportSize: { width: 800, height: 600 },
        instances: [widget({ x: 310, y: 260, width: 20, height: 20 })],
        widgetSizeForInstance,
      }),
    ).toBe(false);
  });

  it("returns false for an empty or unmeasured canvas", () => {
    expect(
      hasVisibleHomeCanvasWidget({
        viewport: { x: 0, y: 0, zoom: 1 },
        viewportSize: { width: 800, height: 600 },
        instances: [],
        widgetSizeForInstance,
      }),
    ).toBe(false);

    expect(
      hasVisibleHomeCanvasWidget({
        viewport: { x: 0, y: 0, zoom: 1 },
        viewportSize: { width: 0, height: 600 },
        instances: [widget()],
        widgetSizeForInstance,
      }),
    ).toBe(false);
  });

  it("checks whether a world point is inside the inset viewport", () => {
    expect(
      isHomeCanvasPointInsideViewport({
        viewport: { x: 0, y: 0, zoom: 1 },
        viewportSize: { width: 800, height: 600 },
        viewportInsetPx: 50,
        point: { x: 400, y: 300 },
      }),
    ).toBe(true);

    expect(
      isHomeCanvasPointInsideViewport({
        viewport: { x: 0, y: 0, zoom: 1 },
        viewportSize: { width: 800, height: 600 },
        viewportInsetPx: 50,
        point: { x: 25, y: 300 },
      }),
    ).toBe(false);
  });

  it("checks whether a world point is inside the inset viewport after left occlusion", () => {
    expect(
      isHomeCanvasPointInsideViewport({
        viewport: { x: 0, y: 0, zoom: 1 },
        viewportSize: { width: 800, height: 600 },
        viewportLeftOcclusionPx: 200,
        viewportInsetPx: 50,
        point: { x: 240, y: 300 },
      }),
    ).toBe(false);

    expect(
      isHomeCanvasPointInsideViewport({
        viewport: { x: 0, y: 0, zoom: 1 },
        viewportSize: { width: 800, height: 600 },
        viewportLeftOcclusionPx: 200,
        viewportInsetPx: 50,
        point: { x: 260, y: 300 },
      }),
    ).toBe(true);
  });
});
