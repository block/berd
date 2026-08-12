import { cn } from "@/shared/lib/cn";

type EdgeFadeDirection = "top" | "bottom";

interface EdgeFadeProps {
  direction?: EdgeFadeDirection;
  className?: string;
  /**
   * CSS color/token used for the opaque edge. Defaults to the dialog/popover
   * glass surface because this primitive is usually placed inside overlays.
   */
  surface?: string;
}

const DIRECTION_TO_GRADIENT: Record<EdgeFadeDirection, string> = {
  top: "to bottom",
  bottom: "to top",
};

/**
 * EdgeFade creates a non-interactive visual fade at a scroll boundary.
 * It does not blur content; use it when a list should tuck under nearby
 * chrome without making text look smeared or out of focus.
 */
export function EdgeFade({
  direction = "top",
  className,
  surface = "var(--surface-popover-glass)",
}: EdgeFadeProps) {
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-x-0 h-8", className)}
      style={{
        background: `linear-gradient(${DIRECTION_TO_GRADIENT[direction]}, ${surface} 0%, transparent 100%)`,
      }}
    />
  );
}
