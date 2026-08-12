import { useEffect, useRef } from "react";
import { cn } from "@/shared/lib/cn";

interface TopFadeProps {
  className?: string;
  scrollElement?: HTMLElement | null;
  surface?: string;
}

const FADE_IN_DISTANCE = 80;

export function TopFade({
  className,
  scrollElement,
  surface = "var(--canvas-base)",
}: TopFadeProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !scrollElement) return;
    let frame = 0;
    let previousOpacity = -1;

    const paint = () => {
      frame = 0;
      const opacity = Math.max(
        0,
        Math.min(1, scrollElement.scrollTop / FADE_IN_DISTANCE),
      );
      if (opacity !== previousOpacity) {
        previousOpacity = opacity;
        el.style.opacity = String(opacity);
      }
    };
    const update = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };

    paint();
    scrollElement.addEventListener("scroll", update, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scrollElement.removeEventListener("scroll", update);
    };
  }, [scrollElement]);

  const initialOpacity = scrollElement
    ? Math.max(0, Math.min(1, scrollElement.scrollTop / FADE_IN_DISTANCE))
    : 0;

  return (
    <div
      ref={ref}
      className={cn("pointer-events-none h-20 w-full", className)}
      style={{
        opacity: initialOpacity,
        background: `linear-gradient(to bottom, ${surface} 0%, transparent 100%)`,
      }}
      aria-hidden="true"
    />
  );
}
