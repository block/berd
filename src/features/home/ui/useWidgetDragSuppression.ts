import type React from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  eventClientPoint,
  movedBeyondWidgetDragThreshold,
  offsetBetween,
  type WidgetGesturePoint,
} from "../lib/widgetGesture";

const CLICK_SUPPRESSION_DURATION_MS = 600;

export interface WidgetFrameGestureHandlers {
  onPointerDownCapture: React.PointerEventHandler<HTMLElement>;
  onPointerMoveCapture: React.PointerEventHandler<HTMLElement>;
  onPointerUpCapture: React.PointerEventHandler<HTMLElement>;
  onPointerCancelCapture: React.PointerEventHandler<HTMLElement>;
  onClickCapture: React.MouseEventHandler<HTMLElement>;
}

export function useWidgetDragSuppression() {
  const suppressClickRef = useRef(false);
  const clickSuppressionTimerRef = useRef<number | null>(null);
  const removeClickBlockerRef = useRef<(() => void) | null>(null);
  const pointerStartRef = useRef<WidgetGesturePoint | null>(null);
  const didDragRef = useRef(false);

  const clearSuppression = useCallback(() => {
    suppressClickRef.current = false;
    didDragRef.current = false;
    if (clickSuppressionTimerRef.current !== null) {
      window.clearTimeout(clickSuppressionTimerRef.current);
      clickSuppressionTimerRef.current = null;
    }
    removeClickBlockerRef.current?.();
  }, []);

  const blockNextClick = useCallback(() => {
    removeClickBlockerRef.current?.();

    const preventNextClick = (event: MouseEvent) => {
      if (!suppressClickRef.current) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      removeClickBlockerRef.current = null;
    };

    window.addEventListener("click", preventNextClick, {
      capture: true,
      once: true,
    });
    removeClickBlockerRef.current = () => {
      window.removeEventListener("click", preventNextClick, {
        capture: true,
      });
      removeClickBlockerRef.current = null;
    };
  }, []);

  const suppressClickBriefly = useCallback(() => {
    suppressClickRef.current = true;
    blockNextClick();

    if (clickSuppressionTimerRef.current !== null) {
      window.clearTimeout(clickSuppressionTimerRef.current);
    }

    clickSuppressionTimerRef.current = window.setTimeout(() => {
      clearSuppression();
    }, CLICK_SUPPRESSION_DURATION_MS);
  }, [blockNextClick, clearSuppression]);

  const shouldIgnoreActivation = useCallback(
    () => suppressClickRef.current || didDragRef.current,
    [],
  );

  const markDragged = useCallback(() => {
    didDragRef.current = true;
    suppressClickBriefly();
  }, [suppressClickBriefly]);

  const suppressClickAfterDrag = useCallback(
    (offset: WidgetGesturePoint) => {
      if (movedBeyondWidgetDragThreshold(offset)) {
        markDragged();
      }
    },
    [markDragged],
  );

  const handlePointerDownCapture = useCallback(
    (event: React.PointerEvent) => {
      clearSuppression();
      pointerStartRef.current = eventClientPoint(event);
    },
    [clearSuppression],
  );

  const handlePointerMoveCapture = useCallback(
    (event: React.PointerEvent) => {
      const start = pointerStartRef.current;
      if (!start || didDragRef.current) {
        return;
      }

      suppressClickAfterDrag(offsetBetween(eventClientPoint(event), start));
    },
    [suppressClickAfterDrag],
  );

  const handlePointerUpCapture = useCallback(
    (event: React.PointerEvent) => {
      const start = pointerStartRef.current;
      pointerStartRef.current = null;
      if (!start) {
        return;
      }

      if (didDragRef.current) {
        markDragged();
        return;
      }

      suppressClickAfterDrag(offsetBetween(eventClientPoint(event), start));
    },
    [markDragged, suppressClickAfterDrag],
  );

  const handlePointerCancelCapture = useCallback(() => {
    pointerStartRef.current = null;
    markDragged();
  }, [markDragged]);

  const handleClickCapture = useCallback((event: React.MouseEvent) => {
    if (!suppressClickRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  }, []);

  const frameHandlers = useMemo<WidgetFrameGestureHandlers>(
    () => ({
      onPointerDownCapture: handlePointerDownCapture,
      onPointerMoveCapture: handlePointerMoveCapture,
      onPointerUpCapture: handlePointerUpCapture,
      onPointerCancelCapture: handlePointerCancelCapture,
      onClickCapture: handleClickCapture,
    }),
    [
      handleClickCapture,
      handlePointerCancelCapture,
      handlePointerDownCapture,
      handlePointerMoveCapture,
      handlePointerUpCapture,
    ],
  );

  useEffect(
    () => () => {
      clearSuppression();
    },
    [clearSuppression],
  );

  return {
    shouldIgnoreActivation,
    suppressClickAfterDrag,
    frameHandlers,
  };
}
