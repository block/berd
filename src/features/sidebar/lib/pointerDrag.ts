export const SIDEBAR_POINTER_DRAG_THRESHOLD_PX = 4;

export function hasExceededPointerDragThreshold({
  startX,
  startY,
  clientX,
  clientY,
  threshold = SIDEBAR_POINTER_DRAG_THRESHOLD_PX,
}: {
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  threshold?: number;
}): boolean {
  return Math.hypot(clientX - startX, clientY - startY) >= threshold;
}

export function isPrimaryPointerButton(event: { button: number }): boolean {
  return event.button === 0;
}

export function schedulePointerDragClickSuppressionReset(
  suppressNextClickRef: { current: boolean },
  resetTimeoutRef: { current: number | null },
): void {
  if (resetTimeoutRef.current !== null) {
    window.clearTimeout(resetTimeoutRef.current);
  }
  resetTimeoutRef.current = window.setTimeout(() => {
    suppressNextClickRef.current = false;
    resetTimeoutRef.current = null;
  }, 0);
}

export function clearPointerDragClickSuppression(
  suppressNextClickRef: { current: boolean },
  resetTimeoutRef: { current: number | null },
): void {
  if (resetTimeoutRef.current !== null) {
    window.clearTimeout(resetTimeoutRef.current);
    resetTimeoutRef.current = null;
  }
  suppressNextClickRef.current = false;
}
