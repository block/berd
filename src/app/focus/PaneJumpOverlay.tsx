import type { FocusRegionRegistration } from "./FocusRegionProvider";

type OverlayRegion = FocusRegionRegistration & {
  rect: DOMRect;
};

const BADGE_VIEWPORT_PADDING = 8;
const BADGE_TOP_EDGE_THRESHOLD = 24;
const ESTIMATED_BADGE_WIDTH = 140;
const ESTIMATED_BADGE_HEIGHT = 28;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function getPaneJumpBadgePosition(rect: DOMRect) {
  const rawTop =
    rect.top < BADGE_TOP_EDGE_THRESHOLD
      ? rect.bottom + BADGE_VIEWPORT_PADDING
      : rect.top + BADGE_VIEWPORT_PADDING;

  return {
    top: clamp(
      rawTop,
      BADGE_VIEWPORT_PADDING,
      window.innerHeight - ESTIMATED_BADGE_HEIGHT - BADGE_VIEWPORT_PADDING,
    ),
    left: clamp(
      rect.left + BADGE_VIEWPORT_PADDING,
      BADGE_VIEWPORT_PADDING,
      window.innerWidth - ESTIMATED_BADGE_WIDTH - BADGE_VIEWPORT_PADDING,
    ),
  };
}

export function PaneJumpOverlay({ regions }: { regions: OverlayRegion[] }) {
  return (
    <div
      className="pointer-events-none fixed inset-0 z-[100] text-[12px] font-normal text-primary-foreground"
      aria-hidden="true"
      data-testid="pane-jump-overlay"
    >
      <div className="sr-only" aria-live="polite">
        pane jump mode. press a shown letter, h j k l, or escape.
      </div>
      {regions.map((region) => {
        const { top, left } = getPaneJumpBadgePosition(region.rect);
        return (
          <div
            key={region.id}
            className="absolute rounded-sm bg-primary px-2 py-1 shadow-popover"
            style={{ top, left }}
          >
            <span>{region.key}</span> <span>{region.label}</span>
          </div>
        );
      })}
    </div>
  );
}
