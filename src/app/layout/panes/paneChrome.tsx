import {
  type CSSProperties,
  forwardRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useState,
} from "react";
import { cn } from "@/shared/lib/cn";
import type { AppShellPaneId, PaneDragReleaseIntent } from "./paneTypes";

export type PaneDragState = {
  paneId: AppShellPaneId;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  hasSeparated: boolean;
  originLeft: number;
  originTop: number;
  originWidth: number;
  originHeight: number;
};

export function usePaneDrag({
  enabled,
  fallbackHeight,
  fallbackWidth,
  onRelease,
  paneId,
  separationThresholdPx = 8,
  surfaceSelector,
  surfaceWidth,
}: {
  enabled: boolean;
  fallbackHeight: number;
  fallbackWidth: number;
  onRelease?: (intent: PaneDragReleaseIntent) => void;
  paneId: AppShellPaneId;
  separationThresholdPx?: number;
  surfaceSelector: string;
  surfaceWidth: number;
}) {
  const [dragState, setDragState] = useState<PaneDragState | null>(null);

  const handleDragStart = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (!enabled || event.button !== 0) return;

      event.preventDefault();
      event.stopPropagation();

      const startX = event.clientX;
      const startY = event.clientY;
      const paneSurface =
        event.currentTarget.closest<HTMLElement>(surfaceSelector) ??
        event.currentTarget;
      const paneRect = paneSurface.getBoundingClientRect();
      const originWidth = paneRect.width > 0 ? paneRect.width : fallbackWidth;
      const originHeight =
        paneRect.height > 0 ? paneRect.height : fallbackHeight;
      let didSeparate = false;

      const updateDragState = (clientX: number, clientY: number) => {
        const deltaX = clientX - startX;
        const deltaY = clientY - startY;
        const hasSeparated =
          Math.abs(deltaX) > separationThresholdPx ||
          Math.abs(deltaY) > separationThresholdPx;
        didSeparate = didSeparate || hasSeparated;

        setDragState({
          paneId,
          startX,
          startY,
          currentX: clientX,
          currentY: clientY,
          hasSeparated,
          originLeft: paneRect.left,
          originTop: paneRect.top,
          originWidth,
          originHeight,
        });
      };

      updateDragState(startX, startY);

      const handleMouseMove = (moveEvent: MouseEvent) => {
        updateDragState(moveEvent.clientX, moveEvent.clientY);
      };

      const cleanup = (clientX = startX, clientY = startY) => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        window.removeEventListener("blur", handleWindowBlur);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";

        if (didSeparate) {
          onRelease?.({
            paneId,
            startClientX: startX,
            startClientY: startY,
            currentClientX: clientX,
            currentClientY: clientY,
            surfaceWidth,
            hasSeparated: didSeparate,
          });
        }

        setDragState(null);
      };

      const handleMouseUp = (upEvent: MouseEvent) => {
        cleanup(upEvent.clientX, upEvent.clientY);
      };

      const handleWindowBlur = () => cleanup();

      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      window.addEventListener("blur", handleWindowBlur);
    },
    [
      enabled,
      fallbackHeight,
      fallbackWidth,
      onRelease,
      paneId,
      separationThresholdPx,
      surfaceSelector,
      surfaceWidth,
    ],
  );

  return {
    dragState,
    handleDragStart,
    isDragging: dragState?.hasSeparated === true,
  };
}

export function usePaneResize<SurfaceId extends string>({
  enabled,
  getStartWidth,
  onResize,
  onResizeBegin,
  onResizeEnd,
}: {
  enabled: boolean;
  getStartWidth: (surfaceId: SurfaceId) => number;
  onResize?: (surfaceId: SurfaceId, width: number) => void;
  onResizeBegin?: () => void;
  onResizeEnd?: () => void;
}) {
  return useCallback(
    (surfaceId: SurfaceId, event: ReactMouseEvent<HTMLElement>) => {
      if (!enabled || event.button !== 0) return;

      event.preventDefault();
      event.stopPropagation();

      const startX = event.clientX;
      const startWidth = getStartWidth(surfaceId);

      onResizeBegin?.();
      onResize?.(surfaceId, startWidth);

      const handleMouseMove = (moveEvent: MouseEvent) => {
        onResize?.(surfaceId, startWidth + moveEvent.clientX - startX);
      };

      const cleanup = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", cleanup);
        window.removeEventListener("blur", cleanup);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        onResizeEnd?.();
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", cleanup);
      window.addEventListener("blur", cleanup);
    },
    [enabled, getStartWidth, onResize, onResizeBegin, onResizeEnd],
  );
}

export const PaneSurface = forwardRef<
  HTMLDivElement,
  {
    children: ReactNode;
    className?: string;
    dataAttributes?: Record<string, boolean | string | undefined>;
    fullHeight?: boolean;
    glass?: boolean;
    testId: string;
    width?: number;
  }
>(function PaneSurface(
  {
    children,
    className,
    dataAttributes,
    fullHeight = false,
    glass = true,
    testId,
    width,
  },
  ref,
) {
  return (
    <div
      ref={ref}
      data-testid={testId}
      className={cn(
        "relative flex flex-shrink-0 flex-col overflow-hidden rounded-md",
        glass ? "bg-sidebar backdrop-blur-md" : "bg-transparent",
        fullHeight && "h-full",
        className,
      )}
      style={{
        ...(glass
          ? {
              backdropFilter: "var(--backdrop-sidebar-panel)",
              WebkitBackdropFilter: "var(--backdrop-sidebar-panel)",
            }
          : null),
        width,
      }}
      {...dataAttributes}
    >
      {children}
    </div>
  );
});

export function PaneDragHandle({
  "aria-label": ariaLabel,
  className,
  onActivate,
  onMouseDown,
  testId,
}: {
  "aria-label": string;
  className?: string;
  onActivate: () => void;
  onMouseDown: (event: ReactMouseEvent<HTMLElement>) => void;
  testId: string;
}) {
  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.detail !== 0) return;

    onActivate();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;

    event.preventDefault();
    onActivate();
  };

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      data-testid={testId}
      title={ariaLabel}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseDown={onMouseDown}
      className={cn(
        "h-2 w-full flex-shrink-0 cursor-grab appearance-none rounded-t-md border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1 active:cursor-grabbing",
        className,
      )}
    />
  );
}

export function PaneLayoutFrame({
  children,
  className,
  gapPx,
  height,
  onPointerEnter,
  onPointerLeave,
  orientation,
  overlays,
  testId,
  underlays,
  width,
}: {
  children: ReactNode;
  className?: string;
  gapPx: number;
  height?: string;
  onPointerEnter?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerLeave?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  orientation: "horizontal" | "vertical";
  overlays?: ReactNode;
  testId: string;
  underlays?: ReactNode;
  width: number;
}) {
  return (
    <div
      className={cn("relative h-full", className)}
      style={{ width, height }}
      data-testid={testId}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {underlays}
      <div
        className={cn(
          "relative z-10 flex h-full gap-[var(--pane-layout-gap)]",
          orientation === "horizontal" ? "flex-row" : "flex-col",
        )}
        style={
          {
            "--pane-layout-gap": `${gapPx}px`,
          } as CSSProperties
        }
      >
        {children}
      </div>
      {overlays}
    </div>
  );
}

export function PaneResizeRail<SurfaceId extends string>({
  dividerClassName,
  onResizeStart,
  surfaceId,
  testId,
  title,
}: {
  dividerClassName?: string;
  onResizeStart: (
    surfaceId: SurfaceId,
    event: ReactMouseEvent<HTMLElement>,
  ) => void;
  surfaceId: SurfaceId;
  testId: string;
  title: string;
}) {
  return (
    <div
      data-testid={testId}
      onMouseDown={(event) => onResizeStart(surfaceId, event)}
      className="group/pane-resize absolute top-2 right-0 bottom-2 z-20 flex w-5 translate-x-1/2 cursor-ew-resize items-center justify-center"
      title={title}
      aria-hidden="true"
    >
      <div
        className={cn(
          "h-8 w-px rounded-full bg-transparent transition-colors group-hover/pane-resize:bg-border",
          dividerClassName,
        )}
      />
    </div>
  );
}

export function PaneDragPreview({
  children,
  dragState,
}: {
  children: ReactNode;
  dragState: PaneDragState;
}) {
  return (
    <div
      className="pointer-events-none fixed z-50"
      style={{
        left: dragState.originLeft,
        top: dragState.originTop,
        width: dragState.originWidth,
        height: dragState.originHeight,
        transform: `translate(${dragState.currentX - dragState.startX}px, ${
          dragState.currentY - dragState.startY
        }px)`,
      }}
      aria-hidden
    >
      {children}
    </div>
  );
}

export function PaneDropIndicator({
  className,
  dock,
  sideLeft,
  stackedTop,
  stackedWidth,
}: {
  className?: string;
  dock: "side" | "stacked";
  sideLeft: number;
  stackedTop: number;
  stackedWidth: number;
}) {
  return (
    <div
      data-testid={`sidebar-session-list-drop-${dock}`}
      className={cn(
        "pointer-events-none absolute z-40 rounded-full bg-primary/70",
        dock === "side" ? "w-0.5" : "h-0.5",
        className,
      )}
      style={
        dock === "side"
          ? ({
              top: 12,
              bottom: 12,
              left: sideLeft,
            } satisfies CSSProperties)
          : ({
              top: stackedTop,
              left: 12,
              width: Math.max(0, stackedWidth - 24),
            } satisfies CSSProperties)
      }
      aria-hidden
    />
  );
}
