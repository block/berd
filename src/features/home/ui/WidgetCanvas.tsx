import type React from "react";
import { useCallback, useMemo, useState } from "react";
import type {
  LayoutCamera,
  LayoutConstraints,
} from "@/features/layout/api/layout";
import { useHomeWidgetStore } from "../stores/homeWidgetStore";
import { HOME_WIDGET_CATALOG_BY_ID } from "../widgets/catalog";
import type {
  WidgetInstance,
  WidgetMutationHandlers,
  WidgetNavigationHandlers,
} from "../widgets/types";
import { WidgetFrame } from "./WidgetFrame";
import { WidgetPicker } from "./WidgetPicker";
import { useHomeCanvasViewport } from "./useHomeCanvasViewport";
import { useWidgetDragSuppression } from "./useWidgetDragSuppression";

interface WidgetCanvasProps extends WidgetNavigationHandlers {
  instances: WidgetInstance[];
  mutations: WidgetMutationHandlers;
}

interface PickerState {
  open: boolean;
  x: number;
  y: number;
  worldX: number;
  worldY: number;
}

const DEFAULT_CAMERA: LayoutCamera = {
  centerX: 0,
  centerY: 0,
  zoomBps: 10_000,
};

const DEFAULT_CONSTRAINTS: LayoutConstraints = {
  minCenter: -100_000,
  maxCenter: 100_000,
  minSize: 1,
  maxSize: 10_000,
  minZoomBps: 1_000,
  maxZoomBps: 20_000,
  maxTitleOverrideLength: 120,
  maxItems: 100,
};

/**
 * WidgetCanvas — the free-form widget layer.
 *
 * Double-clicking the canvas background opens the WidgetPicker at the cursor
 * position. Only instances whose catalog entry has a Component are rendered;
 * stubs are silently skipped until their Component is supplied.
 */
export function WidgetCanvas({
  instances,
  mutations,
  onOpenAgent,
  onSelectSession,
  onOpenAutomation,
}: WidgetCanvasProps) {
  const camera = useHomeWidgetStore((state) => state.camera) ?? DEFAULT_CAMERA;
  const constraints =
    useHomeWidgetStore((state) => state.constraints) ?? DEFAULT_CONSTRAINTS;
  const saveCamera = useHomeWidgetStore((state) => state.saveCamera);
  const dragSuppression = useWidgetDragSuppression();
  const [visuallyLiftedZ, setVisuallyLiftedZ] = useState<
    Record<string, number>
  >({});
  const [picker, setPicker] = useState<PickerState>({
    open: false,
    x: 0,
    y: 0,
    worldX: 0,
    worldY: 0,
  });

  const currentMaxZ = useMemo(
    () => instances.reduce((max, instance) => Math.max(max, instance.z), 0),
    [instances],
  );

  const closePicker = useCallback(() => {
    setPicker((current) =>
      current.open ? { ...current, open: false } : current,
    );
  }, []);

  const handleVisualLift = useCallback((id: string, zIndex: number) => {
    setVisuallyLiftedZ((current) => ({ ...current, [id]: zIndex }));
  }, []);

  const handleVisualLiftReset = useCallback((id: string) => {
    setVisuallyLiftedZ((current) => {
      const { [id]: _removed, ...rest } = current;
      return rest;
    });
  }, []);

  const {
    canvasRef,
    viewport,
    dragPositions,
    worldPointForClientPoint,
    beginPan,
    beginWidgetDrag,
    handlePointerMove,
    finishPointerGesture,
    handleWheel,
  } = useHomeCanvasViewport({
    camera,
    constraints,
    saveCamera,
    onViewportGestureStart: closePicker,
    onWidgetDragStart: (instance) => {
      if (instance.z < currentMaxZ) {
        handleVisualLift(instance.id, currentMaxZ + 1);
      }
    },
    onWidgetDragEnd: ({ id, position, offset }) => {
      dragSuppression.suppressClickAfterDrag(offset);
      handleVisualLiftReset(id);
      mutations.moveWidget(id, position.x, position.y, constraints, {
        bringToFront: true,
      });
    },
  });

  const handleCanvasDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest("[data-home-widget-node]")) {
        return;
      }

      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }

      const screenPoint = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
      const worldPoint = worldPointForClientPoint({
        x: event.clientX,
        y: event.clientY,
      });

      setPicker({
        open: true,
        x: screenPoint.x,
        y: screenPoint.y,
        worldX: worldPoint.x,
        worldY: worldPoint.y,
      });
    },
    [canvasRef, worldPointForClientPoint],
  );

  const handleCanvasPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (
        event.button !== 0 ||
        (event.target as HTMLElement).closest("[data-home-widget-node]")
      ) {
        return;
      }

      beginPan(event);
    },
    [beginPan],
  );

  const preventNativeDrag = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const renderedInstances = instances.filter(
    (instance) => HOME_WIDGET_CATALOG_BY_ID[instance.type]?.Component,
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: freeform spatial canvas; child widgets and picker provide semantic controls
    <div
      ref={canvasRef}
      onDoubleClick={handleCanvasDoubleClick}
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerGesture}
      onPointerCancel={finishPointerGesture}
      onDragStartCapture={preventNativeDrag}
      onWheel={handleWheel}
      className="relative h-full w-full overflow-hidden bg-dot-grid select-none touch-none"
    >
      <div
        className="absolute left-0 top-0 size-0"
        style={{
          transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.zoom})`,
          transformOrigin: "0 0",
        }}
      >
        {renderedInstances.map((instance) => {
          const catalogEntry = HOME_WIDGET_CATALOG_BY_ID[instance.type];
          const position = dragPositions[instance.id] ?? {
            x: instance.x,
            y: instance.y,
          };
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: freeform widget node captures canvas drag gestures; WidgetFrame owns semantics.
            <div
              key={instance.id}
              data-home-widget-node
              draggable={false}
              onPointerDown={(event) => beginWidgetDrag(event, instance)}
              onDragStart={preventNativeDrag}
              style={{
                position: "absolute",
                left: position.x,
                top: position.y,
                zIndex: visuallyLiftedZ[instance.id] ?? instance.z,
                width: catalogEntry.defaultSize.width,
                height: catalogEntry.defaultSize.height,
              }}
            >
              <WidgetFrame
                instance={instance}
                currentMaxZ={currentMaxZ}
                mutations={mutations}
                shouldIgnoreActivation={dragSuppression.shouldIgnoreActivation}
                gestureHandlers={dragSuppression.frameHandlers}
                onVisualLiftReset={handleVisualLiftReset}
                onOpenAgent={onOpenAgent}
                onSelectSession={onSelectSession}
                onOpenAutomation={onOpenAutomation}
              />
            </div>
          );
        })}
      </div>

      <WidgetPicker
        open={picker.open}
        x={picker.x}
        y={picker.y}
        instances={instances}
        onClose={closePicker}
        onSelect={(type, state) => {
          mutations.addWidget(
            type,
            picker.worldX,
            picker.worldY,
            state,
            constraints,
          );
          closePicker();
        }}
      />
    </div>
  );
}
