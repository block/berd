import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  LayoutCamera,
  LayoutConstraints,
} from "@/features/layout/api/layout";
import { cn } from "@/shared/lib/cn";
import { snapCanvasPointToDevicePixels } from "../lib/layoutCamera";
import { useHomeWidgetStore } from "../stores/homeWidgetStore";
import {
  HOME_WIDGET_CATALOG_BY_ID,
  widgetSizeForInstance,
} from "../widgets/catalog";
import type {
  WidgetInstance,
  WidgetMutationHandlers,
  WidgetNavigationHandlers,
} from "../widgets/types";
import { WidgetFrame } from "./WidgetFrame";
import { WidgetPicker } from "./WidgetPicker";
import { useHomeCanvasViewport } from "./useHomeCanvasViewport";
import { useWidgetDragSuppression } from "./useWidgetDragSuppression";

/**
 * Data attribute marking a pinned-widget DOM node. Used by the canvas to
 * distinguish background right-clicks (open picker) from widget right-clicks
 * (let the widget's own UnpinPill handle it), and by tests to locate widget
 * nodes. Exported so call sites and tests share a single source of truth.
 */
export const HOME_WIDGET_NODE_ATTR = "data-home-widget-node";
const HOME_WIDGET_NODE_SELECTOR = `[${HOME_WIDGET_NODE_ATTR}]`;

interface WidgetCanvasProps extends WidgetNavigationHandlers {
  instances: WidgetInstance[];
  mutations: WidgetMutationHandlers;
  animateCameraTransition?: boolean;
  onCreatePersona?: () => void;
  onCreateProject?: () => void;
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
  minZoomBps: 5_000,
  maxZoomBps: 20_000,
  maxTitleOverrideLength: 120,
  maxItems: 100,
};

function currentDevicePixelRatio(): number {
  return typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
}

function useDevicePixelRatio(): number {
  const [devicePixelRatio, setDevicePixelRatio] = useState(
    currentDevicePixelRatio,
  );

  useEffect(() => {
    const updateDevicePixelRatio = () => {
      setDevicePixelRatio(currentDevicePixelRatio());
    };

    window.addEventListener("resize", updateDevicePixelRatio);

    const mediaQuery =
      typeof window.matchMedia === "function"
        ? window.matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
        : null;
    if (mediaQuery?.addEventListener) {
      mediaQuery.addEventListener("change", updateDevicePixelRatio);
    } else {
      mediaQuery?.addListener?.(updateDevicePixelRatio);
    }

    return () => {
      window.removeEventListener("resize", updateDevicePixelRatio);
      if (mediaQuery?.removeEventListener) {
        mediaQuery.removeEventListener("change", updateDevicePixelRatio);
      } else {
        mediaQuery?.removeListener?.(updateDevicePixelRatio);
      }
    };
  }, [devicePixelRatio]);

  return devicePixelRatio;
}

function renderedWidgetPosition(
  position: { x: number; y: number },
  viewport: { x: number; y: number; zoom: number },
  devicePixelRatio: number,
): { x: number; y: number } {
  return snapCanvasPointToDevicePixels(
    {
      x: viewport.x + position.x * viewport.zoom,
      y: viewport.y + position.y * viewport.zoom,
    },
    devicePixelRatio,
  );
}

function renderedWidgetStyle({
  position,
  size,
  zIndex,
  zoom,
}: {
  position: { x: number; y: number };
  size: { width: number; height: number };
  zIndex: number;
  zoom: number;
}): React.CSSProperties {
  return {
    position: "absolute",
    left: position.x,
    top: position.y,
    zIndex,
    width: size.width * zoom,
    height: size.height * zoom,
  };
}

function renderedWidgetContentStyle({
  size,
  zoom,
}: {
  size: { width: number; height: number };
  zoom: number;
}): React.CSSProperties {
  return {
    position: "relative",
    width: size.width,
    height: size.height,
    transform: zoom === 1 ? undefined : `scale(${zoom})`,
    transformOrigin: "top left",
  };
}

function starterStickyPlacementsNearAnchor(
  widgets: WidgetInstance[],
  anchor: { x: number; y: number },
) {
  if (widgets.length === 0) {
    return [];
  }

  const bounds = widgets.reduce(
    (current, widget) => {
      const size = widgetSizeForInstance(widget);
      return {
        minX: Math.min(current.minX, widget.x),
        minY: Math.min(current.minY, widget.y),
        maxX: Math.max(current.maxX, widget.x + size.width),
        maxY: Math.max(current.maxY, widget.y + size.height),
      };
    },
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  );
  const groupCenter = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  };

  return widgets.map((widget) => {
    const size = widgetSizeForInstance(widget);
    return {
      widget,
      centerX: anchor.x + (widget.x + size.width / 2 - groupCenter.x),
      centerY: anchor.y + (widget.y + size.height / 2 - groupCenter.y),
    };
  });
}

const HOME_MIN_ZOOM_BPS = 5_000;
const HOME_MAX_ZOOM_BPS = 20_000;
const WIDGET_TEXT_SCALE_MULTIPLIER = 1.08;

function homeCanvasZoomConstraints(
  constraints: LayoutConstraints,
): LayoutConstraints {
  return {
    ...constraints,
    minZoomBps: Math.max(constraints.minZoomBps, HOME_MIN_ZOOM_BPS),
    maxZoomBps: Math.min(constraints.maxZoomBps, HOME_MAX_ZOOM_BPS),
  };
}

/**
 * WidgetCanvas — the free-form widget layer.
 *
 * Right-clicking the canvas background opens the WidgetPicker at the cursor
 * position. Pinned widgets stopPropagation on their own right-click so the
 * canvas picker does not race the per-widget UnpinPill. Only instances whose
 * catalog entry has a Component are rendered; stubs are silently skipped until
 * their Component is supplied.
 */
export function WidgetCanvas({
  instances,
  mutations,
  animateCameraTransition = false,
  onOpenAgent,
  onOpenProject,
  onOpenSkill,
  onSelectSession,
  onStartProjectChat,
  onOpenAutomation,
  onCreatePersona,
  onCreateProject,
  onOpenSkills,
  onOpenAutomations,
}: WidgetCanvasProps) {
  const { t } = useTranslation("home");
  const camera = useHomeWidgetStore((state) => state.camera) ?? DEFAULT_CAMERA;
  const constraints =
    useHomeWidgetStore((state) => state.constraints) ?? DEFAULT_CONSTRAINTS;
  const viewportConstraints = useMemo(
    () => homeCanvasZoomConstraints(constraints),
    [constraints],
  );
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
  const devicePixelRatio = useDevicePixelRatio();

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
    resizePreviews,
    worldPointForClientPoint,
    beginPan,
    beginWidgetDrag,
    beginWidgetResize,
    handlePointerMove,
    finishPointerGesture,
    handleWheel,
  } = useHomeCanvasViewport({
    camera,
    constraints: viewportConstraints,
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
    onWidgetResizeStart: (instance) => {
      if (instance.z < currentMaxZ) {
        handleVisualLift(instance.id, currentMaxZ + 1);
      }
    },
    onWidgetResizeEnd: ({ id, bounds, offset }) => {
      dragSuppression.suppressClickAfterDrag(offset);
      handleVisualLiftReset(id);
      mutations.resizeWidget(id, bounds.width, bounds.height, constraints, {
        bringToFront: true,
      });
    },
    onWidgetResizeCancel: ({ id }) => {
      handleVisualLiftReset(id);
    },
  });

  const handleCanvasContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest(HOME_WIDGET_NODE_SELECTOR)) {
        // Pinned widgets own their own right-click handler (UnpinPill) and
        // stopPropagation; if we still see one here it originated outside a
        // pin. Either way, do not double-open menus.
        return;
      }

      event.preventDefault();

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
        (event.target as HTMLElement).closest(HOME_WIDGET_NODE_SELECTOR)
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
      onContextMenu={handleCanvasContextMenu}
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerGesture}
      onPointerCancel={finishPointerGesture}
      onDragStartCapture={preventNativeDrag}
      onWheel={handleWheel}
      className="relative h-full w-full overflow-hidden bg-dot-grid select-none touch-none"
    >
      <div className="absolute left-0 top-0 size-0">
        {renderedInstances.map((instance) => {
          const catalogEntry = HOME_WIDGET_CATALOG_BY_ID[instance.type];
          const position = dragPositions[instance.id] ?? {
            x: instance.x,
            y: instance.y,
          };
          const resizePreview = resizePreviews[instance.id];
          const renderWorldPosition = resizePreview ?? position;
          const renderPosition = renderedWidgetPosition(
            renderWorldPosition,
            viewport,
            devicePixelRatio,
          );
          const size = resizePreview ?? widgetSizeForInstance(instance);
          const defaultSize = catalogEntry.defaultSize;
          const widgetScale = Math.min(
            size.width / defaultSize.width,
            size.height / defaultSize.height,
          );
          const widgetTextScale = widgetScale * WIDGET_TEXT_SCALE_MULTIPLIER;
          const widgetStyle = {
            ...renderedWidgetStyle({
              position: renderPosition,
              size,
              zIndex: visuallyLiftedZ[instance.id] ?? instance.z,
              zoom: viewport.zoom,
            }),
            "--widget-scale": widgetScale,
            "--widget-text-scale": widgetTextScale,
          } as React.CSSProperties;
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: freeform widget node captures canvas drag gestures; WidgetFrame owns semantics.
            <div
              key={instance.id}
              {...{ [HOME_WIDGET_NODE_ATTR]: "" }}
              draggable={false}
              onPointerDown={(event) => beginWidgetDrag(event, instance)}
              onDragStart={preventNativeDrag}
              style={widgetStyle}
              className={cn(
                "group/widget",
                animateCameraTransition &&
                  "transition-[left,top] duration-[260ms] ease-out motion-reduce:transition-none",
              )}
            >
              <div
                style={renderedWidgetContentStyle({
                  size,
                  zoom: viewport.zoom,
                })}
              >
                <WidgetFrame
                  instance={instance}
                  currentMaxZ={currentMaxZ}
                  mutations={mutations}
                  shouldIgnoreActivation={
                    dragSuppression.shouldIgnoreActivation
                  }
                  gestureHandlers={dragSuppression.frameHandlers}
                  onVisualLiftReset={handleVisualLiftReset}
                  onOpenAgent={onOpenAgent}
                  onOpenProject={onOpenProject}
                  onOpenSkill={onOpenSkill}
                  onSelectSession={onSelectSession}
                  onStartProjectChat={onStartProjectChat}
                  onOpenAutomation={onOpenAutomation}
                  onCreatePersona={onCreatePersona}
                  onCreateProject={onCreateProject}
                  onOpenSkills={onOpenSkills}
                  onOpenAutomations={onOpenAutomations}
                />
                <button
                  type="button"
                  aria-label={t("widgets.resize.label", {
                    widget: t(catalogEntry.labelKey),
                  })}
                  draggable={false}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    beginWidgetResize(event, instance);
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  className="absolute -right-3 -bottom-3 z-20 hidden size-7 cursor-nwse-resize items-center justify-center rounded-full group-hover/widget:flex focus-visible:flex focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <span
                    className="size-4 rounded-full border border-border bg-background shadow-mini"
                    aria-hidden="true"
                  />
                  <span className="sr-only">
                    {t("widgets.resize.label", {
                      widget: t(catalogEntry.labelKey),
                    })}
                  </span>
                </button>
              </div>
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
        onSelectStarterStickies={(widgets) => {
          const placements = starterStickyPlacementsNearAnchor(widgets, {
            x: picker.worldX,
            y: picker.worldY,
          });
          for (const { widget, centerX, centerY } of placements) {
            mutations.addWidget(
              widget.type,
              centerX,
              centerY,
              widget.state,
              constraints,
            );
          }
          closePicker();
        }}
      />
    </div>
  );
}
