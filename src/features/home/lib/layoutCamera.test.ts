import { describe, expect, it } from "vitest";
import type { LayoutConstraints } from "@/features/layout/api/layout";
import {
  clampLayoutCamera,
  layoutCameraToCanvasViewport,
  canvasViewportToLayoutCamera,
  panCanvasViewport,
  snapCanvasPointToDevicePixels,
  screenToWorld,
  viewportZoomToZoomBps,
  zoomCanvasViewportAtPoint,
  zoomBpsToViewportZoom,
} from "./layoutCamera";

const CONSTRAINTS: LayoutConstraints = {
  minCenter: -1000,
  maxCenter: 1000,
  minSize: 1,
  maxSize: 10_000,
  minZoomBps: 2500,
  maxZoomBps: 20_000,
  maxTitleOverrideLength: 120,
  maxItems: 100,
};

describe("layoutCamera", () => {
  it("converts zoom bps to canvas zoom and back", () => {
    expect(zoomBpsToViewportZoom(12_500)).toBe(1.25);
    expect(viewportZoomToZoomBps(1.23456)).toBe(12_346);
  });

  it("snaps canvas points to physical pixels", () => {
    expect(snapCanvasPointToDevicePixels({ x: 10.4, y: 20.6 }, 1)).toEqual({
      x: 10,
      y: 21,
    });
    expect(snapCanvasPointToDevicePixels({ x: 10.25, y: 20.25 }, 2)).toEqual({
      x: 10.5,
      y: 20.5,
    });
    expect(snapCanvasPointToDevicePixels({ x: 10.2, y: 20.2 }, 1.25)).toEqual({
      x: 10.4,
      y: 20,
    });
  });

  it("maps the default camera to a centered viewport at zoom 1", () => {
    expect(
      layoutCameraToCanvasViewport(
        { centerX: 0, centerY: 0, zoomBps: 10_000 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ x: 400, y: 300, zoom: 1 });
  });

  it("round-trips a non-zero camera center through canvas viewport math", () => {
    const camera = { centerX: 120, centerY: -48, zoomBps: 12_500 };
    const viewportSize = { width: 800, height: 600 };
    const viewport = layoutCameraToCanvasViewport(camera, viewportSize);

    expect(canvasViewportToLayoutCamera(viewport, viewportSize)).toEqual(
      camera,
    );
  });

  it("clamps camera center and zoom against layout constraints", () => {
    expect(
      clampLayoutCamera(
        { centerX: -2000, centerY: 2000, zoomBps: 100_000 },
        CONSTRAINTS,
      ),
    ).toEqual({ centerX: -1000, centerY: 1000, zoomBps: 20_000 });
  });

  it("clamps viewport-derived zoom bps to backend min and max", () => {
    expect(
      canvasViewportToLayoutCamera(
        { x: 0, y: 0, zoom: 0.1 },
        { width: 800, height: 600 },
        CONSTRAINTS,
      ).zoomBps,
    ).toBe(2500);
    expect(
      canvasViewportToLayoutCamera(
        { x: 0, y: 0, zoom: 3 },
        { width: 800, height: 600 },
        CONSTRAINTS,
      ).zoomBps,
    ).toBe(20_000);
  });

  it("preserves the same world center when the viewport size changes", () => {
    const camera = { centerX: 320, centerY: 180, zoomBps: 15_000 };
    const resizedViewport = layoutCameraToCanvasViewport(camera, {
      width: 1200,
      height: 900,
    });

    expect(
      canvasViewportToLayoutCamera(resizedViewport, {
        width: 1200,
        height: 900,
      }),
    ).toEqual(camera);
  });

  it("converts screen points into world points", () => {
    expect(
      screenToWorld({ x: 500, y: 260 }, { x: 400, y: 300, zoom: 2 }),
    ).toEqual({ x: 50, y: -20 });
  });

  it("pans by the screen pointer delta", () => {
    expect(
      panCanvasViewport(
        { x: 400, y: 300, zoom: 1.5 },
        { x: 20, y: 40 },
        { x: 32, y: 35 },
      ),
    ).toEqual({ x: 412, y: 295, zoom: 1.5 });
  });

  it("zooms around the cursor while preserving the hovered world point", () => {
    const viewport = { x: 400, y: 300, zoom: 1 };
    const screenPoint = { x: 520, y: 360 };
    const worldPoint = screenToWorld(screenPoint, viewport);
    const zoomed = zoomCanvasViewportAtPoint(
      viewport,
      screenPoint,
      -120,
      CONSTRAINTS,
    );

    const zoomedWorldPoint = screenToWorld(screenPoint, zoomed);
    expect(zoomedWorldPoint.x).toBeCloseTo(worldPoint.x);
    expect(zoomedWorldPoint.y).toBeCloseTo(worldPoint.y);
    expect(zoomed.zoom).toBeGreaterThan(viewport.zoom);
  });
});
