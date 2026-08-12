export type WidgetGesturePoint = {
  x: number;
  y: number;
};

export const WIDGET_DRAG_THRESHOLD_PX = 3;

export function eventClientPoint(event: {
  clientX: number;
  clientY: number;
}): WidgetGesturePoint {
  return { x: event.clientX, y: event.clientY };
}

export function offsetBetween(
  current: WidgetGesturePoint,
  start: WidgetGesturePoint,
): WidgetGesturePoint {
  return {
    x: current.x - start.x,
    y: current.y - start.y,
  };
}

export function movedBeyondWidgetDragThreshold(
  offset: WidgetGesturePoint,
): boolean {
  return (
    Math.abs(offset.x) > WIDGET_DRAG_THRESHOLD_PX ||
    Math.abs(offset.y) > WIDGET_DRAG_THRESHOLD_PX
  );
}
