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

const MESSAGE_TIMELINE_SCROLL_CONTAINER_CLASS =
  "scrollbar-subtle relative z-0 min-h-0 flex-1 overflow-y-auto overscroll-contain";
const SCROLLBAR_PASSIVE_SUPPRESSED_ATTRIBUTE =
  "data-scrollbar-passive-suppressed";
const SCROLL_REVEAL_LISTENER_OPTIONS: AddEventListenerOptions = {
  passive: true,
};
const RESIZE_DELTA_EPSILON_PX = 0.5;

interface MessageTimelineScrollContainerProps
  extends ComponentPropsWithoutRef<"div"> {
  hasFooter: boolean;
}

function assignForwardedRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === "function") {
    ref(value);
    return;
  }

  if (ref) {
    ref.current = value;
  }
}

export const MessageTimelineScrollContainer = forwardRef<
  HTMLDivElement,
  MessageTimelineScrollContainerProps
>(({ children, className, hasFooter, ...props }, forwardedRef) => {
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
    if (!container) {
      return;
    }

    if (suppressed) {
      container.setAttribute(SCROLLBAR_PASSIVE_SUPPRESSED_ATTRIBUTE, "true");
      return;
    }

    container.removeAttribute(SCROLLBAR_PASSIVE_SUPPRESSED_ATTRIBUTE);
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
    if (!container) {
      return;
    }

    container.addEventListener("focusin", revealScrollbarForUserIntent);
    container.addEventListener("keydown", revealScrollbarForUserIntent);
    container.addEventListener("pointerdown", revealScrollbarForUserIntent);
    container.addEventListener(
      "touchmove",
      revealScrollbarForUserIntent,
      SCROLL_REVEAL_LISTENER_OPTIONS,
    );
    container.addEventListener(
      "wheel",
      revealScrollbarForUserIntent,
      SCROLL_REVEAL_LISTENER_OPTIONS,
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
        SCROLL_REVEAL_LISTENER_OPTIONS,
      );
      container.removeEventListener(
        "wheel",
        revealScrollbarForUserIntent,
        SCROLL_REVEAL_LISTENER_OPTIONS,
      );
    };
  }, [revealScrollbarForUserIntent]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === container);
      if (!entry) {
        return;
      }

      const { width, height } = entry.contentRect;
      const lastSize = lastContainerSizeRef.current;
      lastContainerSizeRef.current = { width, height };

      if (!lastSize) {
        return;
      }

      const sizeChanged =
        Math.abs(width - lastSize.width) > RESIZE_DELTA_EPSILON_PX ||
        Math.abs(height - lastSize.height) > RESIZE_DELTA_EPSILON_PX;
      if (sizeChanged) {
        setPassiveSuppression(true);
      }
    });

    resizeObserver.observe(container);

    return () => resizeObserver.disconnect();
  }, [setPassiveSuppression]);

  return (
    <div
      {...props}
      ref={setContainerRef}
      data-testid="message-timeline-scroll"
      className={cn(
        MESSAGE_TIMELINE_SCROLL_CONTAINER_CLASS,
        !hasFooter && "rounded-md bg-card",
        className,
      )}
    >
      {children}
    </div>
  );
});

MessageTimelineScrollContainer.displayName = "MessageTimelineScrollContainer";
