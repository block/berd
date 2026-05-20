import type { LayoutConstraints } from "@/features/layout/api/layout";

export const GRID_SIZE = 24;

export function snapTo(value: number, gridSize: number = GRID_SIZE): number {
  return Math.round(value / gridSize) * gridSize;
}

export function snapPoint(
  point: { x: number; y: number },
  gridSize: number = GRID_SIZE,
): { x: number; y: number } {
  return { x: snapTo(point.x, gridSize), y: snapTo(point.y, gridSize) };
}

export function clampToBounds(
  point: { x: number; y: number },
  widgetSize: { width: number; height: number },
  bounds: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: Math.min(
      Math.max(0, point.x),
      Math.max(0, bounds.width - widgetSize.width),
    ),
    y: Math.min(
      Math.max(0, point.y),
      Math.max(0, bounds.height - widgetSize.height),
    ),
  };
}

export function isLayoutConstraints(
  value: unknown,
): value is LayoutConstraints {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const constraints = value as Record<string, unknown>;

  return (
    Number.isFinite(constraints.minCenter) &&
    Number.isFinite(constraints.maxCenter) &&
    Number.isFinite(constraints.minZoomBps) &&
    Number.isFinite(constraints.maxZoomBps)
  );
}

export function clampToLayoutConstraints(
  point: { x: number; y: number },
  widgetSize: { width: number; height: number },
  constraints: LayoutConstraints,
): { x: number; y: number } {
  const minX = constraints.minCenter - widgetSize.width / 2;
  const maxX = constraints.maxCenter - widgetSize.width / 2;
  const minY = constraints.minCenter - widgetSize.height / 2;
  const maxY = constraints.maxCenter - widgetSize.height / 2;

  return {
    x: Math.min(Math.max(minX, point.x), maxX),
    y: Math.min(Math.max(minY, point.y), maxY),
  };
}
