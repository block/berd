import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type AriaAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { usePersistedState } from "@/shared/hooks/usePersistedState";

const AGENT_BUILDER_RAIL_FRACTION_STORAGE_KEY =
  "goose:agent-builder-rail-fraction";
/**
 * Builder column as a fraction of the split (0..1). Clamped so neither the
 * chat nor the builder can be squeezed away while both are visible.
 */
const AGENT_BUILDER_RAIL_MIN_FRACTION = 0.3;
const AGENT_BUILDER_RAIL_MAX_FRACTION = 0.72;
/** Keyboard resize step, in fraction units, per arrow keypress. */
const AGENT_BUILDER_RAIL_KEYBOARD_STEP = 0.02;

function clampFraction(fraction: number): number {
  return Math.min(
    Math.max(fraction, AGENT_BUILDER_RAIL_MIN_FRACTION),
    AGENT_BUILDER_RAIL_MAX_FRACTION,
  );
}

/**
 * `null` means the user has not resized yet, so the builder shares width
 * equally with the chat column (50/50). Once dragged, we store the fraction.
 */
function validateFraction(
  value: unknown,
  defaults: number | null,
): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? clampFraction(value)
    : defaults;
}

/** Fraction used for display and keyboard math before the first resize. */
export const AGENT_BUILDER_RAIL_DEFAULT_FRACTION = 0.5;

/**
 * Marks the two-column grid the divider measures against.
 *
 * Resolved by attribute rather than by walking a fixed number of
 * `parentElement` hops: the divider is nested inside the builder *cell*, and
 * hop-counting silently measured that cell instead of the grid. Dividing the
 * pointer offset by the cell width (rather than the grid width) inflated the
 * fraction, so a narrow rail jumped wider the moment it was dragged again.
 */
export const AGENT_BUILDER_GRID_ATTR = "data-agent-builder-grid";

export interface AgentBuilderRailSeparatorProps
  extends Pick<
    AriaAttributes,
    "aria-orientation" | "aria-valuenow" | "aria-valuemin" | "aria-valuemax"
  > {
  role: "separator";
  tabIndex: number;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

export function useResizableAgentBuilderRail() {
  const [railFraction, setRailFraction] = usePersistedState<number | null>(
    AGENT_BUILDER_RAIL_FRACTION_STORAGE_KEY,
    null,
    validateFraction,
  );
  const [isResizingRail, setIsResizingRail] = useState(false);
  // Holds the teardown for an in-progress drag so unmounting mid-drag cannot
  // leave window listeners attached or the body stuck in col-resize/none.
  const activeDragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      activeDragCleanupRef.current?.();
    };
  }, []);

  const startRailResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 && event.button !== undefined) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      // Measure the grid itself, resolved by attribute. `closest` walks
      // however many wrappers actually exist, so the fraction is always
      // pointer-offset ÷ grid width — never ÷ some inner cell's width.
      const gridEl = event.currentTarget.closest<HTMLElement>(
        `[${AGENT_BUILDER_GRID_ATTR}]`,
      );
      const gridRect = gridEl?.getBoundingClientRect();
      if (!gridRect || gridRect.width <= 0) {
        return;
      }

      // A second pointerdown without a matching pointerup would otherwise
      // orphan the first drag's listeners.
      activeDragCleanupRef.current?.();
      setIsResizingRail(true);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const clientX = Number.isFinite(moveEvent.clientX)
          ? moveEvent.clientX
          : gridRect.left;
        // Builder occupies the space to the right of the pointer.
        const builderWidth = gridRect.right - clientX;
        setRailFraction(clampFraction(builderWidth / gridRect.width));
      };

      const cleanup = () => {
        activeDragCleanupRef.current = null;
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
        window.removeEventListener("blur", cleanup);
        setIsResizingRail(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      activeDragCleanupRef.current = cleanup;

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", cleanup, { once: true });
      // A cancelled pointer (OS gesture, touch interruption) never fires
      // pointerup, so without this the drag state would stick.
      window.addEventListener("pointercancel", cleanup, { once: true });
      window.addEventListener("blur", cleanup);
    },
    [setRailFraction],
  );

  const nudgeRailFraction = useCallback(
    (delta: number) => {
      setRailFraction((current) =>
        clampFraction((current ?? AGENT_BUILDER_RAIL_DEFAULT_FRACTION) + delta),
      );
    },
    [setRailFraction],
  );

  const handleSeparatorKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      // The builder sits on the right, so ArrowLeft grows it.
      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          nudgeRailFraction(AGENT_BUILDER_RAIL_KEYBOARD_STEP);
          break;
        case "ArrowRight":
          event.preventDefault();
          nudgeRailFraction(-AGENT_BUILDER_RAIL_KEYBOARD_STEP);
          break;
        case "Home":
          event.preventDefault();
          setRailFraction(AGENT_BUILDER_RAIL_MAX_FRACTION);
          break;
        case "End":
          event.preventDefault();
          setRailFraction(AGENT_BUILDER_RAIL_MIN_FRACTION);
          break;
        default:
          break;
      }
    },
    [nudgeRailFraction, setRailFraction],
  );

  const separatorProps: AgentBuilderRailSeparatorProps = {
    role: "separator",
    // Focusable so the split can be adjusted without a pointer.
    tabIndex: 0,
    "aria-orientation": "vertical",
    "aria-valuenow": Math.round(
      (railFraction ?? AGENT_BUILDER_RAIL_DEFAULT_FRACTION) * 100,
    ),
    "aria-valuemin": Math.round(AGENT_BUILDER_RAIL_MIN_FRACTION * 100),
    "aria-valuemax": Math.round(AGENT_BUILDER_RAIL_MAX_FRACTION * 100),
    onPointerDown: startRailResize,
    onKeyDown: handleSeparatorKeyDown,
  };

  return { railFraction, isResizingRail, startRailResize, separatorProps };
}
