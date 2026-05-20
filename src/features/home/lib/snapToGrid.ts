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
