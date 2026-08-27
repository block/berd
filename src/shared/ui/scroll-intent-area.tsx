import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type ForwardedRef,
} from "react";

import { cn } from "@/shared/lib/cn";

const PASSIVE_SUPPRESSION_ATTRIBUTE = "data-scrollbar-passive-suppressed";
const PASSIVE_LISTENER_OPTIONS: AddEventListenerOptions = { passive: true };
const RESIZE_DELTA_EPSILON_PX = 0.5;

function assignForwardedRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}

/** Native scrolling surface that reveals Berd's subtle scrollbar on user scroll intent. */
export const ScrollIntentArea = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<"div">
>(({ children, className, ...props }, forwardedRef) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastContainerSizeRef = useRef<{
    width: number;
    height: number;
  } | null>(null);

  const setContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      lastContainerSizeRef.current = null;
      assignForwardedRef(forwardedRef, node);
    },
    [forwardedRef],
  );

  const setPassiveSuppression = useCallback((suppressed: boolean) => {
    const container = containerRef.current;
    if (!container) return;
    if (suppressed) {
      container.setAttribute(PASSIVE_SUPPRESSION_ATTRIBUTE, "true");
    } else {
      container.removeAttribute(PASSIVE_SUPPRESSION_ATTRIBUTE);
    }
  }, []);

  const revealScrollbarForUserIntent = useCallback(() => {
    setPassiveSuppression(false);
  }, [setPassiveSuppression]);

  useLayoutEffect(() => {
    setPassiveSuppression(true);
  }, [setPassiveSuppression]);

  useEffect(() => {
    const handleWindowResize = () => setPassiveSuppression(true);
    window.addEventListener("resize", handleWindowResize);
    return () => {
      window.removeEventListener("resize", handleWindowResize);
      setPassiveSuppression(false);
    };
  }, [setPassiveSuppression]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener("focusin", revealScrollbarForUserIntent);
    container.addEventListener("keydown", revealScrollbarForUserIntent);
    container.addEventListener("pointerdown", revealScrollbarForUserIntent);
    container.addEventListener(
      "touchmove",
      revealScrollbarForUserIntent,
      PASSIVE_LISTENER_OPTIONS,
    );
    container.addEventListener(
      "wheel",
      revealScrollbarForUserIntent,
      PASSIVE_LISTENER_OPTIONS,
    );

    return () => {
      container.removeEventListener("focusin", revealScrollbarForUserIntent);
      container.removeEventListener("keydown", revealScrollbarForUserIntent);
      container.removeEventListener(
        "pointerdown",
        revealScrollbarForUserIntent,
      );
      container.removeEventListener(
        "touchmove",
        revealScrollbarForUserIntent,
        PASSIVE_LISTENER_OPTIONS,
      );
      container.removeEventListener(
        "wheel",
        revealScrollbarForUserIntent,
        PASSIVE_LISTENER_OPTIONS,
      );
    };
  }, [revealScrollbarForUserIntent]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === container);
      if (!entry) return;
      const { width, height } = entry.contentRect;
      const lastSize = lastContainerSizeRef.current;
      lastContainerSizeRef.current = { width, height };
      if (
        lastSize &&
        (Math.abs(width - lastSize.width) > RESIZE_DELTA_EPSILON_PX ||
          Math.abs(height - lastSize.height) > RESIZE_DELTA_EPSILON_PX)
      ) {
        setPassiveSuppression(true);
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [setPassiveSuppression]);

  return (
    <div
      {...props}
      ref={setContainerRef}
      className={cn(
        "scrollbar-subtle min-h-0 min-w-0 overflow-y-auto overscroll-contain",
        className,
      )}
    >
      {children}
    </div>
  );
});

ScrollIntentArea.displayName = "ScrollIntentArea";
