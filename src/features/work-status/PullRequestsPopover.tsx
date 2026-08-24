import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { GitPullRequest } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { TopBarIconButton } from "@/shared/ui/top-bar-icon-button";
import { PullRequestsPanel } from "./PullRequestsPanel";
import { WorkStatusBridge } from "./WorkStatusBridge";
import { useWorkStatusStore } from "./workStatusStore";

const DEFAULT_POPOVER_HEIGHT = 480;
const MIN_POPOVER_HEIGHT = 320;
const VIEWPORT_BOTTOM_GUTTER = 96;
const MIN_USABLE_POPOVER_HEIGHT = 160;

function maxAvailableHeight(): number {
  return Math.max(
    MIN_USABLE_POPOVER_HEIGHT,
    (window.visualViewport?.height ?? window.innerHeight) -
      VIEWPORT_BOTTOM_GUTTER,
  );
}

function minAvailableHeight(): number {
  return Math.min(MIN_POPOVER_HEIGHT, maxAvailableHeight());
}

function formatCount(count: number): string {
  return count >= 1_000 ? "999+" : String(count);
}

export function PullRequestsPopover() {
  const { t } = useTranslation("common");
  const pullRequestCount = useWorkStatusStore(
    (state) => state.snapshot.pullRequests.length,
  );
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(DEFAULT_POPOVER_HEIGHT);
  const resizeStartRef = useRef<{ pointerY: number; height: number } | null>(
    null,
  );

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setHeight(
        Math.min(
          maxAvailableHeight(),
          Math.max(minAvailableHeight(), DEFAULT_POPOVER_HEIGHT),
        ),
      );
    }
  };

  useEffect(() => {
    if (!open) return;
    const clampHeight = () => {
      const maxHeight = maxAvailableHeight();
      setHeight((current) =>
        Math.min(maxHeight, Math.max(minAvailableHeight(), current)),
      );
    };
    window.addEventListener("resize", clampHeight);
    window.visualViewport?.addEventListener("resize", clampHeight);
    return () => {
      window.removeEventListener("resize", clampHeight);
      window.visualViewport?.removeEventListener("resize", clampHeight);
    };
  }, [open]);

  const handleResizePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStartRef.current = { pointerY: event.clientY, height };
  };

  const handleResizePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start || !event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }
    const maxHeight = maxAvailableHeight();
    setHeight(
      Math.min(
        maxHeight,
        Math.max(
          minAvailableHeight(),
          start.height + event.clientY - start.pointerY,
        ),
      ),
    );
  };

  const handleResizePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    resizeStartRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const maxHeight = maxAvailableHeight();
    let nextHeight: number | null = null;
    if (event.key === "ArrowUp") nextHeight = height - 24;
    if (event.key === "ArrowDown") nextHeight = height + 24;
    if (event.key === "Home") nextHeight = minAvailableHeight();
    if (event.key === "End") nextHeight = maxHeight;
    if (nextHeight === null) return;
    event.preventDefault();
    setHeight(Math.min(maxHeight, Math.max(minAvailableHeight(), nextHeight)));
  };

  return (
    <>
      <WorkStatusBridge active={open} />
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <TopBarIconButton
            type="button"
            size="icon-top-bar"
            className="relative"
            aria-label={t("workStatus.topBarLabel", {
              count: pullRequestCount,
            })}
            tooltip={t("workStatus.title")}
          >
            <GitPullRequest aria-hidden />
            {pullRequestCount > 0 ? (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 font-medium text-[9px] leading-none text-background tabular-nums"
              >
                {formatCount(pullRequestCount)}
              </span>
            ) : null}
          </TopBarIconButton>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={8}
          style={{ height }}
          className="relative w-[min(460px,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-visible border-0 bg-transparent p-0 shadow-none"
        >
          <PullRequestsPanel />
          <hr
            tabIndex={0}
            aria-label={t("workStatus.resize")}
            aria-orientation="horizontal"
            aria-valuemin={minAvailableHeight()}
            aria-valuemax={maxAvailableHeight()}
            aria-valuenow={Math.round(height)}
            onKeyDown={handleResizeKeyDown}
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerUp}
            onPointerCancel={handleResizePointerUp}
            className="absolute right-3 bottom-0 left-3 z-10 h-3 translate-y-1/2 cursor-ns-resize touch-none rounded-sm border-0 bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </PopoverContent>
      </Popover>
    </>
  );
}
