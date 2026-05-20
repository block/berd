import type React from "react";
import { useCallback, useEffect, useRef } from "react";

const DRAG_SUPPRESSION_THRESHOLD_PX = 3;
const CLICK_SUPPRESSION_DURATION_MS = 600;

function movedBeyondThreshold(offset: { x: number; y: number }): boolean {
  return (
    Math.abs(offset.x) > DRAG_SUPPRESSION_THRESHOLD_PX ||
    Math.abs(offset.y) > DRAG_SUPPRESSION_THRESHOLD_PX
  );
}

export function useWidgetDragSuppression() {
  const suppressClickRef = useRef(false);
  const clickSuppressionTimerRef = useRef<number | null>(null);
  const removeClickBlockerRef = useRef<(() => void) | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const didDragRef = useRef(false);

  const clearSuppression = useCallback(() => {
    suppressClickRef.current = false;
    didDragRef.current = false;
    if (clickSuppressionTimerRef.current) {
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

    if (clickSuppressionTimerRef.current) {
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

  const handleDragStart = useCallback(() => {
    suppressClickBriefly();
  }, [suppressClickBriefly]);

  const handleDragEnd = useCallback(
    (offset: { x: number; y: number }) => {
      if (movedBeyondThreshold(offset)) {
        didDragRef.current = true;
        suppressClickBriefly();
      }
    },
    [suppressClickBriefly],
  );

  const handlePointerDownCapture = useCallback(
    (event: React.PointerEvent) => {
      clearSuppression();
      pointerStartRef.current = {
        x: event.clientX,
        y: event.clientY,
      };
    },
    [clearSuppression],
  );

  const handlePointerMoveCapture = useCallback(
    (event: React.PointerEvent) => {
      const start = pointerStartRef.current;
      if (!start || didDragRef.current) {
        return;
      }

      if (
        movedBeyondThreshold({
          x: event.clientX - start.x,
          y: event.clientY - start.y,
        })
      ) {
        didDragRef.current = true;
        suppressClickBriefly();
      }
    },
    [suppressClickBriefly],
  );

  const handlePointerUpCapture = useCallback(
    (event: React.PointerEvent) => {
      const start = pointerStartRef.current;
      pointerStartRef.current = null;
      if (!start) {
        return;
      }

      if (
        didDragRef.current ||
        movedBeyondThreshold({
          x: event.clientX - start.x,
          y: event.clientY - start.y,
        })
      ) {
        didDragRef.current = true;
        suppressClickBriefly();
      }
    },
    [suppressClickBriefly],
  );

  const handleClickCapture = useCallback((event: React.MouseEvent) => {
    if (!suppressClickRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  }, []);

  useEffect(
    () => () => {
      clearSuppression();
    },
    [clearSuppression],
  );

  return {
    shouldIgnoreActivation,
    handleDragStart,
    handleDragEnd,
    handlePointerDownCapture,
    handlePointerMoveCapture,
    handlePointerUpCapture,
    handleClickCapture,
  };
}
