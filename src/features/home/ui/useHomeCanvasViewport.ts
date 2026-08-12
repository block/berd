import type React from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  LayoutCamera,
  LayoutConstraints,
} from "@/features/layout/api/layout";
import {
  resolveWidgetResizeFromOffset,
  type ResolvedWidgetResize,
} from "../lib/homeWidgetResize";
import {
  clampLayoutCamera,
  type CanvasPoint,
  type CanvasViewport,
  canvasViewportToLayoutCamera,
  layoutCameraToCanvasViewport,
  panCanvasViewport,
  panCanvasViewportByDelta,
  screenToWorld,
  zoomCanvasViewportByScaleAtPoint,
  zoomCanvasViewportAtPoint,
} from "../lib/layoutCamera";
import {
  eventClientPoint,
  movedBeyondWidgetDragThreshold,
  offsetBetween,
} from "../lib/widgetGesture";
import type { WidgetInstance } from "../widgets/types";

type ActivePointer =
  | {
      kind: "pan";
      pointerId: number;
      captureElement: HTMLElement;
      startClient: CanvasPoint;
      startViewport: CanvasViewport;
    }
  | {
      kind: "widget";
      pointerId: number;
      captureElement: HTMLElement;
      hasCapture: boolean;
      widgetId: string;
      startClient: CanvasPoint;
      startViewport: CanvasViewport;
      startPosition: CanvasPoint;
      didDrag: boolean;
      instance: WidgetInstance;
    }
  | {
      kind: "resize";
      pointerId: number;
      captureElement: HTMLElement;
      widgetId: string;
      startClient: CanvasPoint;
      startViewport: CanvasViewport;
      instance: WidgetInstance;
    };

type WidgetDragEnd = {
  id: string;
  position: CanvasPoint;
  offset: CanvasPoint;
};

type WidgetResizeEnd = {
  id: string;
  bounds: ResolvedWidgetResize;
  offset: CanvasPoint;
};

type WidgetResizeCancel = {
  id: string;
};

type SelectionLockSnapshot = {
  bodyUserSelect: string;
  bodyWebkitUserSelect: string;
  documentElementUserSelect: string;
  documentElementWebkitUserSelect: string;
};

type WebkitSelectionStyle = CSSStyleDeclaration & {
  webkitUserSelect?: string;
};

type WebkitGestureEvent = Event & {
  clientX?: number;
  clientY?: number;
  scale?: number;
};

interface UseHomeCanvasViewportOptions {
  camera: LayoutCamera;
  constraints: LayoutConstraints;
  saveCamera: (camera: LayoutCamera) => void;
  onViewportGestureStart?: (kind: "pan" | "widget" | "resize" | "zoom") => void;
  onViewportPanEnd?: (moved: boolean) => void;
  onWidgetDragStart?: (instance: WidgetInstance) => void;
  onWidgetDragEnd?: (drag: WidgetDragEnd) => void;
  onWidgetResizeStart?: (instance: WidgetInstance) => void;
  onWidgetResizeEnd?: (resize: WidgetResizeEnd) => void;
  onWidgetResizeCancel?: (resize: WidgetResizeCancel) => void;
}

function viewportSize(element: HTMLElement | null) {
  const rect = element?.getBoundingClientRect();
  return {
    width: rect?.width ?? 0,
    height: rect?.height ?? 0,
  };
}

function wheelDeltaPixels(
  event: React.WheelEvent<HTMLElement>,
  viewport: ReturnType<typeof viewportSize>,
): CanvasPoint {
  const multiplier =
    event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.height : 1;

  return {
    x: (event.deltaX ?? 0) * multiplier,
    y: (event.deltaY ?? 0) * multiplier,
  };
}

function restoreStyleProperty(
  style: CSSStyleDeclaration,
  property: string,
  value: string,
): void {
  if (value) {
    style.setProperty(property, value);
    return;
  }

  style.removeProperty(property);
}

function webkitUserSelect(style: CSSStyleDeclaration): string {
  return (style as WebkitSelectionStyle).webkitUserSelect ?? "";
}

function setSelectionDisabled(style: CSSStyleDeclaration): void {
  style.setProperty("user-select", "none");
  style.setProperty("-webkit-user-select", "none");
  (style as WebkitSelectionStyle).webkitUserSelect = "none";
}

function restoreWebkitUserSelect(
  style: CSSStyleDeclaration,
  value: string,
): void {
  if (value) {
    style.setProperty("-webkit-user-select", value);
  } else {
    style.removeProperty("-webkit-user-select");
  }
  (style as WebkitSelectionStyle).webkitUserSelect = value;
}

function releasePointerCapture({
  captureElement,
  pointerId,
}: ActivePointer): void {
  if (captureElement.hasPointerCapture?.(pointerId) === false) {
    return;
  }
  captureElement.releasePointerCapture?.(pointerId);
}

function markWidgetDragStarted(
  activePointer: Extract<ActivePointer, { kind: "widget" }>,
  onWidgetDragStart: ((instance: WidgetInstance) => void) | undefined,
  capturePointer: boolean,
): void {
  activePointer.didDrag = true;

  if (capturePointer && activePointer.captureElement.setPointerCapture) {
    activePointer.captureElement.setPointerCapture(activePointer.pointerId);
    activePointer.hasCapture = true;
  }

  onWidgetDragStart?.(activePointer.instance);
}

function widgetPositionFromOffset(
  activePointer: Extract<ActivePointer, { kind: "widget" }>,
  offset: CanvasPoint,
): CanvasPoint {
  const { startPosition, startViewport } = activePointer;
  return {
    x: startPosition.x + offset.x / startViewport.zoom,
    y: startPosition.y + offset.y / startViewport.zoom,
  };
}

function widgetResizeFromOffset(
  activePointer: Extract<ActivePointer, { kind: "resize" }>,
  constraints: LayoutConstraints,
  offset: CanvasPoint,
): ResolvedWidgetResize {
  return resolveWidgetResizeFromOffset({
    instance: activePointer.instance,
    offset,
    viewportZoom: activePointer.startViewport.zoom,
    bounds: constraints,
  });
}

export function useHomeCanvasViewport({
  camera,
  constraints,
  saveCamera,
  onViewportGestureStart,
  onViewportPanEnd,
  onWidgetDragStart,
  onWidgetDragEnd,
  onWidgetResizeStart,
  onWidgetResizeEnd,
  onWidgetResizeCancel,
}: UseHomeCanvasViewportOptions) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const activePointerRef = useRef<ActivePointer | null>(null);
  const cameraSaveTimerRef = useRef<number | null>(null);
  const documentSelectionLockRef = useRef<SelectionLockSnapshot | null>(null);
  const gestureScaleRef = useRef<number | null>(null);
  const [viewport, setViewport] = useState<CanvasViewport>(() =>
    layoutCameraToCanvasViewport(camera, { width: 0, height: 0 }, constraints),
  );
  const [canvasSize, setCanvasSize] = useState(() => viewportSize(null));
  const [dragPositions, setDragPositions] = useState<
    Record<string, CanvasPoint>
  >({});
  const [resizePreviews, setResizePreviews] = useState<
    Record<string, ResolvedWidgetResize>
  >({});

  const viewportCamera = useCallback(
    (nextViewport: CanvasViewport) =>
      canvasViewportToLayoutCamera(
        nextViewport,
        viewportSize(canvasRef.current),
        constraints,
      ),
    [constraints],
  );

  const clearScheduledCameraSave = useCallback(() => {
    if (cameraSaveTimerRef.current !== null) {
      window.clearTimeout(cameraSaveTimerRef.current);
      cameraSaveTimerRef.current = null;
    }
  }, []);

  const commitCamera = useCallback(
    (nextViewport: CanvasViewport) => {
      clearScheduledCameraSave();
      saveCamera(viewportCamera(nextViewport));
    },
    [clearScheduledCameraSave, saveCamera, viewportCamera],
  );

  const scheduleCameraSave = useCallback(
    (nextViewport: CanvasViewport) => {
      clearScheduledCameraSave();
      cameraSaveTimerRef.current = window.setTimeout(() => {
        cameraSaveTimerRef.current = null;
        commitCamera(nextViewport);
      }, 150);
    },
    [clearScheduledCameraSave, commitCamera],
  );

  const lockDocumentSelection = useCallback(() => {
    if (documentSelectionLockRef.current !== null) {
      return;
    }

    documentSelectionLockRef.current = {
      bodyUserSelect: document.body.style.getPropertyValue("user-select"),
      bodyWebkitUserSelect: webkitUserSelect(document.body.style),
      documentElementUserSelect:
        document.documentElement.style.getPropertyValue("user-select"),
      documentElementWebkitUserSelect: webkitUserSelect(
        document.documentElement.style,
      ),
    };
    setSelectionDisabled(document.documentElement.style);
    setSelectionDisabled(document.body.style);
    document.getSelection()?.removeAllRanges();
  }, []);

  const unlockDocumentSelection = useCallback(() => {
    if (documentSelectionLockRef.current === null) {
      return;
    }

    restoreStyleProperty(
      document.documentElement.style,
      "user-select",
      documentSelectionLockRef.current.documentElementUserSelect,
    );
    restoreWebkitUserSelect(
      document.documentElement.style,
      documentSelectionLockRef.current.documentElementWebkitUserSelect,
    );
    restoreStyleProperty(
      document.body.style,
      "user-select",
      documentSelectionLockRef.current.bodyUserSelect,
    );
    restoreWebkitUserSelect(
      document.body.style,
      documentSelectionLockRef.current.bodyWebkitUserSelect,
    );
    documentSelectionLockRef.current = null;
  }, []);

  const syncViewportToCamera = useCallback(() => {
    const size = viewportSize(canvasRef.current);
    setCanvasSize(size);
    if (size.width <= 0 || size.height <= 0) {
      return;
    }

    setViewport(
      layoutCameraToCanvasViewport(
        clampLayoutCamera(camera, constraints),
        size,
        constraints,
      ),
    );
  }, [camera, constraints]);

  useLayoutEffect(() => {
    syncViewportToCamera();
  }, [syncViewportToCamera]);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) {
      return;
    }

    syncViewportToCamera();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", syncViewportToCamera);
      return () => window.removeEventListener("resize", syncViewportToCamera);
    }

    const resizeObserver = new ResizeObserver(() => {
      syncViewportToCamera();
    });
    resizeObserver.observe(element);

    return () => resizeObserver.disconnect();
  }, [syncViewportToCamera]);

  useEffect(
    () => () => {
      clearScheduledCameraSave();
      const activePointer = activePointerRef.current;
      if (activePointer) {
        releasePointerCapture(activePointer);
      }
      unlockDocumentSelection();
    },
    [clearScheduledCameraSave, unlockDocumentSelection],
  );

  const clearWidgetDragPosition = useCallback(
    (widgetId: string) =>
      setDragPositions(({ [widgetId]: _removed, ...rest }) => rest),
    [],
  );

  const clearWidgetResizePreview = useCallback(
    (widgetId: string) =>
      setResizePreviews(({ [widgetId]: _removed, ...rest }) => rest),
    [],
  );

  const worldPointForClientPoint = useCallback(
    (point: CanvasPoint): CanvasPoint => {
      const rect = canvasRef.current?.getBoundingClientRect();
      const screenPoint = {
        x: point.x - (rect?.left ?? 0),
        y: point.y - (rect?.top ?? 0),
      };
      return screenToWorld(screenPoint, viewport);
    },
    [viewport],
  );

  const beginPan = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      lockDocumentSelection();
      event.currentTarget.setPointerCapture(event.pointerId);
      onViewportGestureStart?.("pan");
      activePointerRef.current = {
        kind: "pan",
        pointerId: event.pointerId,
        captureElement: event.currentTarget,
        startClient: eventClientPoint(event),
        startViewport: viewport,
      };
    },
    [lockDocumentSelection, onViewportGestureStart, viewport],
  );

  const beginWidgetDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>, instance: WidgetInstance) => {
      if (typeof event.button === "number" && event.button !== 0) {
        return;
      }

      onViewportGestureStart?.("widget");
      activePointerRef.current = {
        kind: "widget",
        pointerId: event.pointerId,
        captureElement: event.currentTarget,
        hasCapture: false,
        widgetId: instance.id,
        startClient: eventClientPoint(event),
        startViewport: viewport,
        startPosition: { x: instance.x, y: instance.y },
        didDrag: false,
        instance,
      };
    },
    [onViewportGestureStart, viewport],
  );

  const beginWidgetResize = useCallback(
    (event: React.PointerEvent<HTMLElement>, instance: WidgetInstance) => {
      if (typeof event.button === "number" && event.button !== 0) {
        return;
      }

      lockDocumentSelection();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      onViewportGestureStart?.("resize");
      onWidgetResizeStart?.(instance);
      activePointerRef.current = {
        kind: "resize",
        pointerId: event.pointerId,
        captureElement: event.currentTarget,
        widgetId: instance.id,
        startClient: eventClientPoint(event),
        startViewport: viewport,
        instance,
      };
    },
    [
      lockDocumentSelection,
      onViewportGestureStart,
      onWidgetResizeStart,
      viewport,
    ],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const activePointer = activePointerRef.current;
      if (!activePointer || activePointer.pointerId !== event.pointerId) {
        return;
      }

      const eventClient = eventClientPoint(event);

      if (activePointer.kind === "pan") {
        setViewport(
          panCanvasViewport(
            activePointer.startViewport,
            activePointer.startClient,
            eventClient,
          ),
        );
        return;
      }

      const offset = offsetBetween(eventClient, activePointer.startClient);
      if (activePointer.kind === "resize") {
        setResizePreviews((current) => ({
          ...current,
          [activePointer.widgetId]: widgetResizeFromOffset(
            activePointer,
            constraints,
            offset,
          ),
        }));
        return;
      }

      if (!activePointer.didDrag && !movedBeyondWidgetDragThreshold(offset)) {
        return;
      }
      if (!activePointer.didDrag) {
        lockDocumentSelection();
        markWidgetDragStarted(activePointer, onWidgetDragStart, true);
      }

      const nextPosition = widgetPositionFromOffset(activePointer, offset);
      setDragPositions((current) => ({
        ...current,
        [activePointer.widgetId]: nextPosition,
      }));
    },
    [constraints, lockDocumentSelection, onWidgetDragStart],
  );

  const finishPointerGesture = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const activePointer = activePointerRef.current;
      if (!activePointer || activePointer.pointerId !== event.pointerId) {
        return;
      }

      activePointerRef.current = null;
      unlockDocumentSelection();
      if (
        activePointer.kind === "pan" ||
        activePointer.kind === "resize" ||
        activePointer.hasCapture
      ) {
        releasePointerCapture(activePointer);
      }

      if (event.type === "pointercancel") {
        if (activePointer.kind === "pan") {
          setViewport(activePointer.startViewport);
          return;
        }

        if (activePointer.kind === "resize") {
          clearWidgetResizePreview(activePointer.widgetId);
          onWidgetResizeCancel?.({ id: activePointer.widgetId });
          return;
        }

        clearWidgetDragPosition(activePointer.widgetId);
        return;
      }

      const eventClient = eventClientPoint(event);
      const offset = offsetBetween(eventClient, activePointer.startClient);

      if (activePointer.kind === "pan") {
        const moved = offset.x !== 0 || offset.y !== 0;
        onViewportPanEnd?.(moved);
        if (!moved) {
          return;
        }

        const nextViewport = panCanvasViewport(
          activePointer.startViewport,
          activePointer.startClient,
          eventClient,
        );
        setViewport(nextViewport);
        commitCamera(nextViewport);
        return;
      }

      if (activePointer.kind === "resize") {
        if (offset.x === 0 && offset.y === 0) {
          clearWidgetResizePreview(activePointer.widgetId);
          onWidgetResizeCancel?.({ id: activePointer.widgetId });
          return;
        }

        const finalBounds = widgetResizeFromOffset(
          activePointer,
          constraints,
          offset,
        );

        clearScheduledCameraSave();
        onWidgetResizeEnd?.({
          id: activePointer.widgetId,
          bounds: finalBounds,
          offset,
        });
        clearWidgetResizePreview(activePointer.widgetId);
        return;
      }

      if (!activePointer.didDrag && !movedBeyondWidgetDragThreshold(offset)) {
        return;
      }
      if (!activePointer.didDrag) {
        markWidgetDragStarted(activePointer, onWidgetDragStart, false);
      }

      const finalPosition = widgetPositionFromOffset(activePointer, offset);

      clearScheduledCameraSave();
      onWidgetDragEnd?.({
        id: activePointer.widgetId,
        position: finalPosition,
        offset,
      });
      clearWidgetDragPosition(activePointer.widgetId);
    },
    [
      clearScheduledCameraSave,
      clearWidgetDragPosition,
      clearWidgetResizePreview,
      commitCamera,
      constraints,
      onViewportPanEnd,
      onWidgetDragEnd,
      onWidgetDragStart,
      onWidgetResizeCancel,
      onWidgetResizeEnd,
      unlockDocumentSelection,
    ],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLElement>) => {
      event.preventDefault();

      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }

      onViewportGestureStart?.(event.ctrlKey || event.metaKey ? "zoom" : "pan");

      setViewport((currentViewport) => {
        const nextViewport =
          event.ctrlKey || event.metaKey
            ? zoomCanvasViewportAtPoint(
                currentViewport,
                {
                  x: event.clientX - rect.left,
                  y: event.clientY - rect.top,
                },
                event.deltaY,
                constraints,
              )
            : panCanvasViewportByDelta(
                currentViewport,
                wheelDeltaPixels(event, rect),
              );

        scheduleCameraSave(nextViewport);
        return nextViewport;
      });
    },
    [constraints, onViewportGestureStart, scheduleCameraSave],
  );

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) {
      return;
    }

    const handleGestureStart = (event: WebkitGestureEvent) => {
      event.preventDefault();
      gestureScaleRef.current = event.scale ?? 1;
      onViewportGestureStart?.("zoom");
    };

    const handleGestureChange = (event: WebkitGestureEvent) => {
      event.preventDefault();

      const rect = element.getBoundingClientRect();
      const currentScale = event.scale ?? gestureScaleRef.current ?? 1;
      const previousScale = gestureScaleRef.current ?? 1;
      gestureScaleRef.current = currentScale;

      if (currentScale <= 0 || previousScale <= 0) {
        return;
      }

      const zoomFactor = currentScale / previousScale;
      setViewport((currentViewport) => {
        const nextViewport = zoomCanvasViewportByScaleAtPoint(
          currentViewport,
          {
            x: (event.clientX ?? rect.left + rect.width / 2) - rect.left,
            y: (event.clientY ?? rect.top + rect.height / 2) - rect.top,
          },
          zoomFactor,
          constraints,
        );
        scheduleCameraSave(nextViewport);
        return nextViewport;
      });
    };

    const handleGestureEnd = () => {
      gestureScaleRef.current = null;
    };

    element.addEventListener("gesturestart", handleGestureStart);
    element.addEventListener("gesturechange", handleGestureChange);
    element.addEventListener("gestureend", handleGestureEnd);

    return () => {
      element.removeEventListener("gesturestart", handleGestureStart);
      element.removeEventListener("gesturechange", handleGestureChange);
      element.removeEventListener("gestureend", handleGestureEnd);
    };
  }, [constraints, onViewportGestureStart, scheduleCameraSave]);

  return {
    canvasRef,
    viewport,
    canvasSize,
    dragPositions,
    resizePreviews,
    worldPointForClientPoint,
    beginPan,
    beginWidgetDrag,
    beginWidgetResize,
    handlePointerMove,
    finishPointerGesture,
    handleWheel,
  };
}
