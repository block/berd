import {
  useCallback,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { usePersistedState } from "@/shared/hooks/usePersistedState";
import { CP_TOTAL_W } from "../ui/ChatContextPanel";

const RIGHT_RAIL_WIDTH_STORAGE_KEY = "goose:chat-right-rail-width";
const RIGHT_RAIL_DEFAULT_WIDTH = CP_TOTAL_W;
const RIGHT_RAIL_MIN_WIDTH = 280;
const RIGHT_RAIL_MAX_WIDTH = 460;

function clampRightRailWidth(width: number): number {
  return Math.min(Math.max(width, RIGHT_RAIL_MIN_WIDTH), RIGHT_RAIL_MAX_WIDTH);
}

function validateRightRailWidth(value: unknown, defaults: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clampRightRailWidth(value)
    : defaults;
}

export function useResizableRightRail() {
  const [railWidth, setRailWidth] = usePersistedState(
    RIGHT_RAIL_WIDTH_STORAGE_KEY,
    RIGHT_RAIL_DEFAULT_WIDTH,
    validateRightRailWidth,
  );
  const [isResizingRail, setIsResizingRail] = useState(false);

  const startRailResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 && event.button !== undefined) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setIsResizingRail(true);
      const startX = Number.isFinite(event.clientX) ? event.clientX : 0;
      const startWidth = railWidth;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const clientX = Number.isFinite(moveEvent.clientX)
          ? moveEvent.clientX
          : startX;
        setRailWidth(clampRightRailWidth(startWidth - (clientX - startX)));
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("blur", cleanup);
        setIsResizingRail(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", cleanup, { once: true });
      window.addEventListener("blur", cleanup);
    },
    [railWidth, setRailWidth],
  );

  return { railWidth, isResizingRail, startRailResize };
}
