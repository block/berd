import { useEffect, type RefObject } from "react";

interface UsePaneScrollIntoViewOptions {
  containerRef: RefObject<HTMLElement | null>;
  targetSelector: string | null;
  topOffsetPx?: number;
  bottomOffsetPx?: number;
  maxAttempts?: number;
  onAfterScroll?: () => void;
}

function getScrollBehavior(): ScrollBehavior {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
    ? "auto"
    : "smooth";
}

function scrollToTop(element: HTMLElement, top: number) {
  const nextTop = Math.max(0, top);
  const behavior = getScrollBehavior();

  if (behavior === "smooth" && typeof element.scrollTo === "function") {
    element.scrollTo({ top: nextTop, behavior });
    return;
  }

  element.scrollTop = nextTop;
}

export function usePaneScrollIntoView({
  containerRef,
  targetSelector,
  topOffsetPx = 0,
  bottomOffsetPx = 0,
  maxAttempts = 3,
  onAfterScroll,
}: UsePaneScrollIntoViewOptions) {
  useEffect(() => {
    if (!targetSelector) return;

    let raf = 0;
    let attemptsLeft = maxAttempts;

    const scrollTargetIntoView = () => {
      const container = containerRef.current;
      const target = container?.querySelector<HTMLElement>(targetSelector);
      if (!container || !target) {
        if (attemptsLeft-- > 0) {
          raf = requestAnimationFrame(scrollTargetIntoView);
        }
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const visibleTop = containerRect.top + topOffsetPx;
      const visibleBottom = containerRect.bottom - bottomOffsetPx;

      if (targetRect.top < visibleTop) {
        scrollToTop(
          container,
          container.scrollTop + targetRect.top - visibleTop,
        );
        onAfterScroll?.();
      } else if (targetRect.bottom > visibleBottom) {
        scrollToTop(
          container,
          container.scrollTop + targetRect.bottom - visibleBottom,
        );
        onAfterScroll?.();
      }
    };

    raf = requestAnimationFrame(scrollTargetIntoView);
    return () => cancelAnimationFrame(raf);
  }, [
    bottomOffsetPx,
    containerRef,
    maxAttempts,
    onAfterScroll,
    targetSelector,
    topOffsetPx,
  ]);
}
