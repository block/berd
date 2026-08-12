import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";

interface UseTextareaAutosizeOptions {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  getMaxHeightPx: () => number;
  layoutKey?: unknown;
}

interface UseTextareaAutosizeResult {
  resetHeight: () => void;
  scheduleAutosize: () => void;
}

export function useTextareaAutosize({
  textareaRef,
  value,
  getMaxHeightPx,
  layoutKey,
}: UseTextareaAutosizeOptions): UseTextareaAutosizeResult {
  const frameRef = useRef<number | null>(null);
  const observedWidthRef = useRef<number | null>(null);

  const cancelScheduledAutosize = useCallback(() => {
    if (frameRef.current === null || typeof window === "undefined") {
      frameRef.current = null;
      return;
    }

    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const autosize = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, getMaxHeightPx())}px`;
  }, [getMaxHeightPx, textareaRef]);

  const scheduleAutosize = useCallback(() => {
    if (frameRef.current !== null) {
      return;
    }

    if (
      typeof window === "undefined" ||
      typeof window.requestAnimationFrame !== "function"
    ) {
      autosize();
      return;
    }

    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      autosize();
    });
  }, [autosize]);

  const resetHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "auto";
  }, [textareaRef]);

  useLayoutEffect(() => {
    void layoutKey;
    void value;
    cancelScheduledAutosize();
    autosize();
  }, [autosize, cancelScheduledAutosize, layoutKey, value]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width;
      if (typeof nextWidth !== "number") {
        return;
      }

      const previousWidth = observedWidthRef.current;
      if (previousWidth !== null && Math.abs(previousWidth - nextWidth) < 0.5) {
        return;
      }

      observedWidthRef.current = nextWidth;
      scheduleAutosize();
    });

    observer.observe(textarea);
    return () => {
      observer.disconnect();
      observedWidthRef.current = null;
    };
  }, [scheduleAutosize, textareaRef]);

  useEffect(() => cancelScheduledAutosize, [cancelScheduledAutosize]);

  return { resetHeight, scheduleAutosize };
}
