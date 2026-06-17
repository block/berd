import type {
  CanvasViewport,
  ViewportSize,
} from "@/features/home/lib/layoutCamera";
import type { WidgetInstance, WidgetSize } from "../widgets/types";

type WidgetSizeForInstance = (instance: WidgetInstance) => WidgetSize;

interface HomeCanvasVisibilityInput {
  viewport: CanvasViewport;
  viewportSize: ViewportSize;
  instances: readonly WidgetInstance[];
  widgetSizeForInstance: WidgetSizeForInstance;
  viewportInsetPx?: number;
  viewportLeftOcclusionPx?: number;
}

interface HomeCanvasPointVisibilityInput {
  viewport: CanvasViewport;
  viewportSize: ViewportSize;
  point: { x: number; y: number };
  viewportInsetPx?: number;
  viewportLeftOcclusionPx?: number;
}

interface HomeCanvasWidgetVisibilityInput {
  viewport: CanvasViewport;
  viewportSize: ViewportSize;
  instance: WidgetInstance;
  widgetSizeForInstance: WidgetSizeForInstance;
  viewportInsetPx?: number;
  viewportLeftOcclusionPx?: number;
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function normalizedViewportInsetPx(
  viewportSize: ViewportSize,
  viewportInsetPx: number,
): number {
  if (!Number.isFinite(viewportInsetPx) || viewportInsetPx <= 0) {
    return 0;
  }

  return Math.min(
    viewportInsetPx,
    viewportSize.width / 2,
    viewportSize.height / 2,
  );
}

function normalizedViewportLeftOcclusionPx(
  viewportSize: ViewportSize,
  viewportLeftOcclusionPx: number,
): number {
  if (
    !Number.isFinite(viewportLeftOcclusionPx) ||
    viewportLeftOcclusionPx <= 0
  ) {
    return 0;
  }

  return Math.min(viewportLeftOcclusionPx, viewportSize.width);
}

function viewportWorldRect({
  viewport,
  viewportSize,
  viewportInsetPx = 0,
  viewportLeftOcclusionPx = 0,
}: {
  viewport: CanvasViewport;
  viewportSize: ViewportSize;
  viewportInsetPx?: number;
  viewportLeftOcclusionPx?: number;
}) {
  if (
    !isPositiveFinite(viewport.zoom) ||
    !isPositiveFinite(viewportSize.width) ||
    !isPositiveFinite(viewportSize.height)
  ) {
    return null;
  }

  const leftOcclusionPx = normalizedViewportLeftOcclusionPx(
    viewportSize,
    viewportLeftOcclusionPx,
  );
  const visibleViewportSize = {
    width: viewportSize.width - leftOcclusionPx,
    height: viewportSize.height,
  };
  if (!isPositiveFinite(visibleViewportSize.width)) {
    return null;
  }

  const insetPx = normalizedViewportInsetPx(
    visibleViewportSize,
    viewportInsetPx,
  );
  return {
    minX: (leftOcclusionPx + insetPx - viewport.x) / viewport.zoom,
    minY: (insetPx - viewport.y) / viewport.zoom,
    maxX: (viewportSize.width - insetPx - viewport.x) / viewport.zoom,
    maxY: (viewportSize.height - insetPx - viewport.y) / viewport.zoom,
  };
}

export function isHomeCanvasWidgetVisible({
  viewport,
  viewportSize,
  instance,
  widgetSizeForInstance,
  viewportInsetPx,
  viewportLeftOcclusionPx,
}: HomeCanvasWidgetVisibilityInput): boolean {
  const visibleWorldRect = viewportWorldRect({
    viewport,
    viewportSize,
    viewportInsetPx,
    viewportLeftOcclusionPx,
  });
  if (!visibleWorldRect) {
    return false;
  }

  const size = widgetSizeForInstance(instance);
  const widgetRect = {
    minX: instance.x,
    minY: instance.y,
    maxX: instance.x + size.width,
    maxY: instance.y + size.height,
  };

  return (
    widgetRect.minX < visibleWorldRect.maxX &&
    widgetRect.maxX > visibleWorldRect.minX &&
    widgetRect.minY < visibleWorldRect.maxY &&
    widgetRect.maxY > visibleWorldRect.minY
  );
}

export function hasVisibleHomeCanvasWidget({
  viewport,
  viewportSize,
  instances,
  widgetSizeForInstance,
  viewportInsetPx,
  viewportLeftOcclusionPx,
}: HomeCanvasVisibilityInput): boolean {
  return instances.some((instance) =>
    isHomeCanvasWidgetVisible({
      viewport,
      viewportSize,
      instance,
      widgetSizeForInstance,
      viewportInsetPx,
      viewportLeftOcclusionPx,
    }),
  );
}

export function isHomeCanvasPointInsideViewport({
  viewport,
  viewportSize,
  point,
  viewportInsetPx,
  viewportLeftOcclusionPx,
}: HomeCanvasPointVisibilityInput): boolean {
  const visibleWorldRect = viewportWorldRect({
    viewport,
    viewportSize,
    viewportInsetPx,
    viewportLeftOcclusionPx,
  });
  if (!visibleWorldRect) {
    return false;
  }

  return (
    point.x >= visibleWorldRect.minX &&
    point.x <= visibleWorldRect.maxX &&
    point.y >= visibleWorldRect.minY &&
    point.y <= visibleWorldRect.maxY
  );
}
