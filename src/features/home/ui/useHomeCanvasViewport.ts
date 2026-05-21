import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LayoutCamera,
  LayoutConstraints,
} from "@/features/layout/api/layout";
import {
  clampLayoutCamera,
  type CanvasPoint,
  type CanvasViewport,
  canvasViewportToLayoutCamera,
  layoutCameraToCanvasViewport,
  panCanvasViewport,
  screenToWorld,
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
    };

type WidgetDragEnd = {
  id: string;
  position: CanvasPoint;
  offset: CanvasPoint;
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

interface UseHomeCanvasViewportOptions {
  camera: LayoutCamera;
  constraints: LayoutConstraints;
  saveCamera: (camera: LayoutCamera) => void;
  onViewportGestureStart?: () => void;
  onWidgetDragStart?: (instance: WidgetInstance) => void;
  onWidgetDragEnd?: (drag: WidgetDragEnd) => void;
}

function viewportSize(element: HTMLElement | null) {
  const rect = element?.getBoundingClientRect();
  return {
    width: rect?.width ?? 0,
    height: rect?.height ?? 0,
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

export function useHomeCanvasViewport({
  camera,
  constraints,
  saveCamera,
  onViewportGestureStart,
  onWidgetDragStart,
  onWidgetDragEnd,
}: UseHomeCanvasViewportOptions) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const activePointerRef = useRef<ActivePointer | null>(null);
  const cameraSaveTimerRef = useRef<number | null>(null);
  const documentSelectionLockRef = useRef<SelectionLockSnapshot | null>(null);
  const [viewport, setViewport] = useState<CanvasViewport>(() =>
    layoutCameraToCanvasViewport(camera, { width: 0, height: 0 }, constraints),
  );
  const [dragPositions, setDragPositions] = useState<
    Record<string, CanvasPoint>
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

  useEffect(() => {
    const nextCamera = clampLayoutCamera(camera, constraints);
    setViewport(
      layoutCameraToCanvasViewport(
        nextCamera,
        viewportSize(canvasRef.current),
        constraints,
      ),
    );
  }, [camera, constraints]);

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
      onViewportGestureStart?.();
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

      onViewportGestureStart?.();
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
    [lockDocumentSelection, onWidgetDragStart],
  );

  const finishPointerGesture = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const activePointer = activePointerRef.current;
      if (!activePointer || activePointer.pointerId !== event.pointerId) {
        return;
      }

      activePointerRef.current = null;
      unlockDocumentSelection();
      if (activePointer.kind === "pan" || activePointer.hasCapture) {
        releasePointerCapture(activePointer);
      }

      if (event.type === "pointercancel") {
        if (activePointer.kind === "pan") {
          setViewport(activePointer.startViewport);
          return;
        }

        clearWidgetDragPosition(activePointer.widgetId);
        return;
      }

      const eventClient = eventClientPoint(event);
      const offset = offsetBetween(eventClient, activePointer.startClient);

      if (activePointer.kind === "pan") {
        if (offset.x === 0 && offset.y === 0) {
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

      if (!activePointer.didDrag && !movedBeyondWidgetDragThreshold(offset)) {
        return;
      }
      if (!activePointer.didDrag) {
        markWidgetDragStarted(activePointer, onWidgetDragStart, false);
      }

      const finalPosition = widgetPositionFromOffset(activePointer, offset);

      clearScheduledCameraSave();
      clearWidgetDragPosition(activePointer.widgetId);
      onWidgetDragEnd?.({
        id: activePointer.widgetId,
        position: finalPosition,
        offset,
      });
    },
    [
      clearScheduledCameraSave,
      clearWidgetDragPosition,
      commitCamera,
      onWidgetDragEnd,
      onWidgetDragStart,
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

      const nextViewport = zoomCanvasViewportAtPoint(
        viewport,
        {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        },
        event.deltaY,
        constraints,
      );

      onViewportGestureStart?.();
      setViewport(nextViewport);
      scheduleCameraSave(nextViewport);
    },
    [constraints, onViewportGestureStart, scheduleCameraSave, viewport],
  );

  return {
    canvasRef,
    viewport,
    dragPositions,
    worldPointForClientPoint,
    beginPan,
    beginWidgetDrag,
    handlePointerMove,
    finishPointerGesture,
    handleWheel,
  };
}
