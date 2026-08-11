import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";

export interface SessionTimelineMarker {
  /** Stable key of the date-group header row. */
  key: string;
  /** Localized group label ("Today", "Yesterday", "August 4, 2026"). */
  label: string;
  /** Index of the header row in the flattened virtualized list. */
  index: number;
  /**
   * Number of sessions in this date group. Weights the rail spacing so busy
   * (typically recent) dates take up more room, like Google Photos.
   */
  count?: number;
}

interface SessionTimelineScrubberProps {
  markers: SessionTimelineMarker[];
  /** Key of the group currently at the top of the viewport. */
  activeKey?: string;
  onJump: (index: number) => void;
  /** True when older sessions exist beyond the loaded window. */
  hasMore?: boolean;
  /** Called when the user scrubs into the unloaded tail below the markers. */
  onLoadOlder?: () => void;
  /**
   * True while a page of older sessions is being fetched. The tail narrates it,
   * because a page can arrive filtered down to nothing — no new markers — and
   * a silent tail would read as a dead control.
   */
  isLoadingOlder?: boolean;
  className?: string;
}

/** Share of the rail reserved for loaded markers when older history exists. */
const LOADED_SPAN_WITH_TAIL = 0.85;

/** Faint dashes rendered in the unloaded tail zone. */
const TAIL_DASH_COUNT = 4;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Google Photos-style ruler scrubber for the session history list: a slim
 * full-height vertical rail on the right edge with one tick dash per date
 * group. Marker spacing is weighted by each group's session count, so busy
 * recent dates spread out instead of being crushed together. Clicking or
 * dragging along the rail rapid-scrolls the virtualized list to the nearest
 * date group; hovering reveals the nearest date label.
 *
 * When older sessions exist beyond the loaded window (`hasMore`), the bottom
 * of the rail is an unloaded-history tail: faint dashes and an "Older" button.
 * Scrubbing into it — or activating the button — jumps to the oldest loaded
 * group and asks the parent to load the next page, so the rail keeps growing
 * toward the very first session.
 */
export function SessionTimelineScrubber({
  markers,
  activeKey,
  onJump,
  hasMore = false,
  onLoadOlder,
  isLoadingOlder = false,
  className,
}: SessionTimelineScrubberProps) {
  const { t } = useTranslation(["sessions"]);
  const railRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const lastDragMarkerRef = useRef<number | null>(null);
  const tailFiredRef = useRef(false);
  const [hoverMarker, setHoverMarker] = useState<number | null>(null);

  // The pointer path releases its request guard on gesture end, but a button
  // press that lands mid-load has no matching key/pointer up: the button is
  // disabled by then and disabled elements stop emitting those events. Settle
  // the guard when the parent reports the fetch finished, so the control asks
  // for the next page instead of latching dead after the first one.
  useEffect(() => {
    if (!isLoadingOlder) tailFiredRef.current = false;
  }, [isLoadingOlder]);

  if (markers.length < 2) return null;

  const lastIndex = markers.length - 1;
  const foundActive = markers.findIndex((marker) => marker.key === activeKey);
  const activeMarker = foundActive === -1 ? 0 : foundActive;
  const showTail = hasMore && Boolean(onLoadOlder);
  const loadedSpan = showTail ? LOADED_SPAN_WITH_TAIL : 1;

  // Weighted positions: the gap below marker i is proportional to its
  // session count, so a day with 12 sessions owns more rail than a day with
  // one. With no counts every weight is 1 and this degrades to even spacing.
  const weights = markers.map((marker) => Math.max(1, marker.count ?? 1));
  const cumulativeBefore: number[] = [];
  let cumulative = 0;
  for (const weight of weights) {
    cumulativeBefore.push(cumulative);
    cumulative += weight;
  }
  const denominator = cumulativeBefore[lastIndex] || 1;
  const positions = cumulativeBefore.map(
    (value) => (value / denominator) * loadedSpan,
  );

  // The one date the rail calls out besides the newest: what the user is
  // scrubbing to right now (hover/drag), falling back to where the list is
  // parked so the rail is never label-less.
  const focusedMarker = hoverMarker ?? activeMarker;

  const ratioFromY = (clientY: number): number => {
    const rail = railRef.current;
    if (!rail) return 0;
    const rect = rail.getBoundingClientRect();
    if (rect.height <= 0) return 0;
    return clamp((clientY - rect.top) / rect.height, 0, 1);
  };

  const nearestMarkerFromRatio = (ratio: number): number => {
    let nearest = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let position = 0; position < positions.length; position += 1) {
      const distance = Math.abs(ratio - positions[position]);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = position;
      }
    }
    return nearest;
  };

  const isTailRatio = (ratio: number): boolean =>
    showTail && ratio > loadedSpan + 0.02;

  const jumpTo = (markerPosition: number) => {
    const marker = markers[markerPosition];
    if (marker) onJump(marker.index);
  };

  // One ask per interaction, shared by the drag gesture and the Older button:
  // a drag parked in the tail, or a held Enter key, must not queue pages. The
  // in-flight check covers the window before the guard is released, since the
  // parent's loading flag can arrive after the interaction has already ended.
  const requestOlder = () => {
    if (isLoadingOlder || tailFiredRef.current) return;
    tailFiredRef.current = true;
    onLoadOlder?.();
  };

  const enterTail = () => {
    // Land on the oldest loaded group and ask for more history.
    setHoverMarker(lastIndex);
    jumpTo(lastIndex);
    requestOlder();
  };

  // Keyboard equivalent of scrubbing into the tail: same jump, same guard.
  const handleOlderPress = () => {
    jumpTo(lastIndex);
    requestOlder();
  };

  // The press-equivalent of `endDrag`: releasing the key or button re-arms the
  // control, so held Enter auto-repeat asks once rather than once per repeat.
  const releaseOlderRequest = () => {
    tailFiredRef.current = false;
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    const ratio = ratioFromY(event.clientY);
    if (isTailRatio(ratio)) {
      lastDragMarkerRef.current = lastIndex;
      enterTail();
      return;
    }
    const nearest = nearestMarkerFromRatio(ratio);
    lastDragMarkerRef.current = nearest;
    setHoverMarker(nearest);
    jumpTo(nearest);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const ratio = ratioFromY(event.clientY);
    if (isTailRatio(ratio)) {
      if (draggingRef.current) {
        if (lastDragMarkerRef.current !== lastIndex) {
          lastDragMarkerRef.current = lastIndex;
        }
        enterTail();
      } else {
        setHoverMarker(lastIndex);
      }
      return;
    }
    const nearest = nearestMarkerFromRatio(ratio);
    setHoverMarker(nearest);
    if (!draggingRef.current) return;
    if (nearest !== lastDragMarkerRef.current) {
      lastDragMarkerRef.current = nearest;
      jumpTo(nearest);
    }
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    tailFiredRef.current = false;
    if (draggingRef.current) {
      draggingRef.current = false;
      lastDragMarkerRef.current = null;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  };

  const handlePointerLeave = () => {
    if (!draggingRef.current) setHoverMarker(null);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = Math.min(activeMarker + 1, lastIndex);
        break;
      case "ArrowUp":
        next = Math.max(activeMarker - 1, 0);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = lastIndex;
        break;
      default:
        return;
    }
    event.preventDefault();
    jumpTo(next);
  };

  const olderLabel = isLoadingOlder
    ? t("history.timeline.loadingOlder", { defaultValue: "Loading…" })
    : t("history.timeline.older", { defaultValue: "Older" });

  return (
    // The Older control is a sibling of the rail, not a child: `role="slider"`
    // is Children Presentational, so a button nested inside the rail would have
    // its semantics flattened away and stop being an activatable AT target.
    <div className={cn("relative flex", className)}>
      {/* A custom ruler scrubber rather than input[type=range]: a native range
          input cannot render per-marker ticks and date labels along the rail. */}
      <div
        ref={railRef}
        role="slider"
        tabIndex={0}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={lastIndex}
        aria-valuenow={activeMarker}
        aria-valuetext={markers[activeMarker]?.label}
        aria-label={t("history.timeline.label", {
          defaultValue: "Jump to date",
        })}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={handlePointerLeave}
        onKeyDown={handleKeyDown}
        className={cn(
          "relative w-12 cursor-pointer touch-none select-none outline-none",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        )}
      >
        {markers.map((marker, position) => {
          const active = position === activeMarker;
          const focused = position === focusedMarker;
          // Two labels only: the newest group as a fixed anchor ("Today"), and
          // whichever date is being scrubbed to — the hovered one during a
          // gesture, otherwise wherever the list is parked. Sampling every nth
          // group instead read as a set of arbitrary dates.
          const showLabel = position === 0 || focused;
          return (
            <div
              key={marker.key}
              className="pointer-events-none absolute right-0 flex -translate-y-1/2 items-center gap-1.5"
              style={{ top: `${positions[position] * 100}%` }}
            >
              {showLabel ? (
                <span
                  className={cn(
                    "whitespace-nowrap text-right text-[10px] leading-none",
                    focused
                      ? "font-medium text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {marker.label}
                </span>
              ) : null}
              <span
                data-timeline-dash
                className={cn(
                  "h-px transition-all",
                  active ? "w-5 bg-foreground" : "w-3 bg-muted-foreground/40",
                )}
              />
            </div>
          );
        })}

        {showTail &&
          Array.from({ length: TAIL_DASH_COUNT }, (_, tailIndex) => {
            const tailPosition =
              loadedSpan +
              ((tailIndex + 1) / (TAIL_DASH_COUNT + 1)) * (1 - loadedSpan);
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: static decorative dashes with no identity or reordering.
                key={`tail-${tailIndex}`}
                data-timeline-tail-dash
                className="pointer-events-none absolute right-0 h-px w-2 -translate-y-1/2 bg-muted-foreground/20"
                style={{ top: `${tailPosition * 100}%` }}
              />
            );
          })}
      </div>

      {showTail && (
        // `aria-disabled` rather than `disabled`: a disabled button leaves the
        // tab order, so a keyboard user who presses this would have their focus
        // dumped to the body the moment loading starts. Activation is refused
        // by the shared guard instead.
        <button
          type="button"
          data-timeline-tail-label
          aria-disabled={isLoadingOlder}
          onClick={handleOlderPress}
          // Releasing re-arms the guard, so holding Enter (which auto-repeats
          // keydown) asks for one page rather than one per repeat.
          onKeyUp={releaseOlderRequest}
          onPointerUp={releaseOlderRequest}
          className={cn(
            "absolute bottom-0 right-0 flex -translate-y-1/2 items-center gap-1.5",
            "touch-none rounded-sm outline-none",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
            isLoadingOlder ? "cursor-default" : "cursor-pointer",
          )}
        >
          <span
            // The tail narrates itself because a requested page can arrive
            // filtered down to nothing, and a silent tail reads as dead.
            aria-live="polite"
            className={cn(
              "whitespace-nowrap text-right text-[10px] leading-none transition-colors",
              isLoadingOlder
                ? "text-muted-foreground"
                : "text-muted-foreground/60",
            )}
          >
            {olderLabel}
          </span>
          <span
            aria-hidden="true"
            className={cn(
              "h-px w-3 transition-colors",
              isLoadingOlder
                ? "animate-pulse bg-muted-foreground/60"
                : "bg-muted-foreground/20",
            )}
          />
        </button>
      )}
    </div>
  );
}
