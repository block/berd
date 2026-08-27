import type React from "react";
import { Crosshair } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  LayoutCamera,
  LayoutConstraints,
} from "@/features/layout/api/layout";
import { cn } from "@/shared/lib/cn";
import { GlassButton } from "@/shared/ui/glass-button";
import { useProfileCapability } from "@/shared/profile/capabilities";
import {
  consumeStarterWidgetPickerRequest,
  hasStarterWidgetPickerRequest,
  OPEN_STARTER_WIDGET_PICKER_EVENT,
} from "@/features/home/onboarding/starterWidgetTask";
import { clearStarterHomeLayoutEligibility } from "@/features/home/onboarding/starterHomeLayout";
import {
  hasVisibleHomeCanvasWidget,
  isHomeCanvasPointInsideViewport,
  isHomeCanvasWidgetVisible,
} from "../lib/homeCanvasVisibility";
import { snapCanvasPointToDevicePixels } from "../lib/layoutCamera";
import { useHomeWidgetStore } from "../stores/homeWidgetStore";
import {
  HOME_WIDGET_CATALOG_BY_ID,
  widgetSizeForInstance,
  widgetSizeProfile,
} from "../widgets/catalog";
import type { WorkspaceNameRequest } from "@/features/chat/hooks/useChatSessionController";
import type {
  WidgetInstance,
  WidgetMutationHandlers,
  WidgetNavigationHandlers,
} from "../widgets/types";
import { WidgetFrame } from "./WidgetFrame";
import {
  WIDGET_PICKER_SIDE_OFFSET,
  WIDGET_PICKER_WIDTH,
  WidgetPicker,
} from "./WidgetPicker";
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
const HOME_CANVAS_INTERACTIVE_SELECTOR =
  "[data-home-canvas-interactive='true']";
const HOME_WIDGET_DRAG_HANDLE_SELECTOR =
  "[data-home-widget-drag-handle='true']";

interface WidgetCanvasProps extends WidgetNavigationHandlers {
  instances: WidgetInstance[];
  pickerInstances?: WidgetInstance[];
  mutations: WidgetMutationHandlers;
  animateCameraTransition?: boolean;
  onRecenter?: () => void;
  recenterTarget?: { x: number; y: number } | null;
  recenterLabel?: string;
  recenterTitle?: string;
  viewportLeftOcclusionPx?: number;
  onCreatePersona?: () => void;
  onCreateProject?: () => void;
  onWorkspaceNameRequest?: (request: WorkspaceNameRequest) => void;
  starterTasksAvailable?: boolean;
  onRestoreStarterTasks?: () => void;
}

interface PickerState {
  open: boolean;
  x: number;
  y: number;
  worldX: number;
  worldY: number;
  side: "left" | "right";
  focusOnOpen: boolean;
}

// We decide which side to open the picker on up front using its widest stage,
// so the narrow stage-one pills and the wide stage-two card stay on the same
// side of the click instead of the card flipping across the cursor near the
// right edge of the screen. Width/offset come from the picker itself so the two
// stay in sync.
const PICKER_VIEWPORT_EDGE_PADDING = 16;

const DEFAULT_CAMERA: LayoutCamera = {
  centerX: 0,
  centerY: 0,
  zoomBps: 9_000,
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

function isAutomationOnlyWidget(instance: WidgetInstance): boolean {
  return (
    instance.type === "automationOutputPin" ||
    (instance.type === "stickyNote" &&
      instance.state?.noteId === "onboarding:manage-automations")
  );
}

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

/**
 * Aspect-locked widgets can use a transform-only preview without changing
 * layout. Freely resizable widgets need real dimensions so text is not scaled
 * a second time after widget CSS variables have already updated.
 */
function renderedWidgetContentStyleForResizePreview({
  committedSize,
  previewSize,
  preserveLayout,
  zoom,
}: {
  committedSize: { width: number; height: number };
  previewSize: { width: number; height: number };
  preserveLayout: boolean;
  zoom: number;
}): React.CSSProperties {
  if (!preserveLayout) {
    return renderedWidgetContentStyle({ size: previewSize, zoom });
  }

  const scaleX = (previewSize.width / committedSize.width) * zoom;
  const scaleY = (previewSize.height / committedSize.height) * zoom;

  if (Math.abs(scaleX - scaleY) > 0.001) {
    return renderedWidgetContentStyle({ size: previewSize, zoom });
  }

  return {
    position: "relative",
    width: committedSize.width,
    height: committedSize.height,
    transformOrigin: "top left",
    transform: scaleX === 1 ? undefined : `scale(${scaleX})`,
  };
}

const HOME_MIN_ZOOM_BPS = 5_000;
const HOME_MAX_ZOOM_BPS = 20_000;
const WIDGET_TEXT_SCALE_MULTIPLIER = 1.08;
const RECENTER_VISIBILITY_INSET_PX = 50;
const RECENTER_CONTROL_EXIT_MS = 180;

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
 * catalog entry has a Component and whose feature is enabled are rendered;
 * stubs are silently skipped until their Component is supplied.
 */
export function WidgetCanvas({
  instances,
  pickerInstances = instances,
  mutations,
  animateCameraTransition = false,
  onRecenter,
  recenterTarget,
  recenterLabel,
  recenterTitle,
  viewportLeftOcclusionPx = 0,
  onOpenAgent,
  onTagAgentInComposer,
  onTagProjectInComposer,
  onTagSkillInComposer,
  onOpenProject,
  onOpenSkill,
  onSelectSession,
  onStartProjectChat,
  onOpenAutomation,
  onRunPrompt,
  onCreatePersona,
  onCreateProject,
  onWorkspaceNameRequest,
  onOpenSkills,
  onOpenAutomations,
  onStartOnboardingTour,
  onResolveBerdyAgent,
  starterTasksAvailable = false,
  onRestoreStarterTasks,
}: WidgetCanvasProps) {
  const { t } = useTranslation("home");
  const resolvedRecenterLabel =
    recenterLabel ?? t("widgets.canvasControls.recenterVisibleLabel");
  const resolvedRecenterTitle =
    recenterTitle ?? t("widgets.canvasControls.recenterTitle");
  const automationsEnabled = useProfileCapability("automations");
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
  // Canvas chat focus is deliberately ephemeral. It is separate from route
  // selection and widget persistence so restoring visible cards never creates
  // a typing target or clears unread state.
  const [focusedCanvasChatId, setFocusedCanvasChatId] = useState<string | null>(
    null,
  );
  const [picker, setPicker] = useState<PickerState>({
    open: false,
    x: 0,
    y: 0,
    worldX: 0,
    worldY: 0,
    side: "right",
    focusOnOpen: false,
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
  } = useHomeCanvasViewport({
    camera,
    constraints: viewportConstraints,
    saveCamera,
    onViewportGestureStart: (kind) => {
      clearStarterHomeLayoutEligibility();
      if (kind !== "pan") closePicker();
    },
    onViewportPanEnd: (moved) => {
      if (!moved) closePicker();
    },
    onWidgetDragStart: (instance) => {
      clearStarterHomeLayoutEligibility();
      handleVisualLift(instance.id, currentMaxZ + 1);
    },
    onWidgetDragEnd: ({ id, position, offset }) => {
      dragSuppression.suppressClickAfterDrag(offset);
      handleVisualLiftReset(id);
      mutations.moveWidget(id, position.x, position.y, constraints, {
        bringToFront: true,
      });
    },
    onWidgetResizeStart: (instance) => {
      clearStarterHomeLayoutEligibility();
      handleVisualLift(instance.id, currentMaxZ + 1);
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

      // Open leftward when the wide stage-two card wouldn't fit to the right of
      // the cursor, so the menu hugs the click instead of jumping across it.
      const roomOnRight = window.innerWidth - event.clientX;
      const side: "left" | "right" =
        roomOnRight <
        WIDGET_PICKER_WIDTH +
          WIDGET_PICKER_SIDE_OFFSET +
          PICKER_VIEWPORT_EDGE_PADDING
          ? "left"
          : "right";

      setPicker({
        open: true,
        x: screenPoint.x,
        y: screenPoint.y,
        worldX: worldPoint.x,
        worldY: worldPoint.y,
        side,
        focusOnOpen: false,
      });
    },
    [canvasRef, worldPointForClientPoint],
  );

  useEffect(() => {
    const openStarterPicker = (): boolean => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return false;
      const starterTasks = instances.find(
        (instance) =>
          instance.type === "stickyNote" &&
          instance.state?.noteId === "onboarding:starter-tasks",
      );
      if (!starterTasks) return false;

      const taskSize = widgetSizeForInstance(starterTasks);
      const anchorWorld = {
        x: starterTasks.x - 24,
        y: starterTasks.y + 56,
      };
      const screenPoint = {
        x: anchorWorld.x * viewport.zoom + viewport.x,
        y: anchorWorld.y * viewport.zoom + viewport.y,
      };
      setPicker({
        open: true,
        x: screenPoint.x,
        y: screenPoint.y,
        worldX: anchorWorld.x,
        worldY: starterTasks.y + taskSize.height + 96,
        side: "left",
        focusOnOpen: true,
      });
      return true;
    };
    const handleStarterPickerRequest = () => {
      if (hasStarterWidgetPickerRequest() && openStarterPicker()) {
        consumeStarterWidgetPickerRequest();
      }
    };
    window.addEventListener(
      OPEN_STARTER_WIDGET_PICKER_EVENT,
      handleStarterPickerRequest,
    );
    handleStarterPickerRequest();
    return () =>
      window.removeEventListener(
        OPEN_STARTER_WIDGET_PICKER_EVENT,
        handleStarterPickerRequest,
      );
  }, [canvasRef, instances, viewport]);

  const handleCanvasPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      if ((event.target as HTMLElement).closest(HOME_WIDGET_NODE_SELECTOR)) {
        return;
      }

      setFocusedCanvasChatId(null);
      beginPan(event);
    },
    [beginPan],
  );

  const handleCanvasChatAvailabilityChange = useCallback(
    (widgetId: string, _available: boolean) => {
      // Any mount/availability boundary invalidates the old gesture grant.
      // A newly renderable card must be deliberately activated again.
      setFocusedCanvasChatId((current) =>
        current === widgetId ? null : current,
      );
    },
    [],
  );

  const preventNativeDrag = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleCanvasWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (
        (event.target as HTMLElement).closest(HOME_CANVAS_INTERACTIVE_SELECTOR)
      ) {
        return;
      }

      handleWheel(event);
    },
    [handleWheel],
  );

  useEffect(() => {
    if (
      focusedCanvasChatId &&
      !instances.some(
        (instance) =>
          instance.id === focusedCanvasChatId &&
          instance.type === "chatPin" &&
          instance.state?.presentation === "expanded",
      )
    ) {
      setFocusedCanvasChatId(null);
    }
  }, [focusedCanvasChatId, instances]);

  const renderedInstances = useMemo(
    () =>
      instances.filter(
        (instance) =>
          HOME_WIDGET_CATALOG_BY_ID[instance.type]?.Component &&
          (!isAutomationOnlyWidget(instance) || automationsEnabled),
      ),
    [automationsEnabled, instances],
  );
  const hasVisibleWidget = useMemo(
    () =>
      hasVisibleHomeCanvasWidget({
        viewport,
        viewportSize: canvasSize,
        instances: renderedInstances,
        widgetSizeForInstance,
        viewportInsetPx: RECENTER_VISIBILITY_INSET_PX,
        viewportLeftOcclusionPx,
      }),
    [canvasSize, renderedInstances, viewport, viewportLeftOcclusionPx],
  );
  const recenterTargetInView = useMemo(
    () =>
      recenterTarget
        ? isHomeCanvasPointInsideViewport({
            viewport,
            viewportSize: canvasSize,
            point: recenterTarget,
            viewportInsetPx: RECENTER_VISIBILITY_INSET_PX,
            viewportLeftOcclusionPx,
          })
        : false,
    [canvasSize, recenterTarget, viewport, viewportLeftOcclusionPx],
  );
  const showRecenterControl = Boolean(
    onRecenter &&
      renderedInstances.length > 0 &&
      recenterTarget &&
      canvasSize.width > 0 &&
      canvasSize.height > 0 &&
      !hasVisibleWidget &&
      !recenterTargetInView,
  );
  const [renderRecenterControl, setRenderRecenterControl] =
    useState(showRecenterControl);

  useEffect(() => {
    if (showRecenterControl) {
      setRenderRecenterControl(true);
      return;
    }

    if (!renderRecenterControl) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setRenderRecenterControl(false);
    }, RECENTER_CONTROL_EXIT_MS);

    return () => window.clearTimeout(timeout);
  }, [renderRecenterControl, showRecenterControl]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: freeform spatial canvas; child widgets and picker provide semantic controls
    <div
      ref={canvasRef}
      data-home-widget-canvas="true"
      onContextMenu={handleCanvasContextMenu}
      onPointerDownCapture={(event) => {
        if (event.button !== 0) return;
        const owner = (event.target as HTMLElement).closest<HTMLElement>(
          HOME_WIDGET_NODE_SELECTOR,
        );
        if (!owner || owner.dataset.homeWidgetId !== focusedCanvasChatId) {
          setFocusedCanvasChatId(null);
        }
      }}
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerGesture}
      onPointerCancel={finishPointerGesture}
      onDragStartCapture={preventNativeDrag}
      onWheel={handleCanvasWheel}
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
          const committedSize = widgetSizeForInstance(instance);
          const previewSize = resizePreview
            ? {
                width: resizePreview.width,
                height: resizePreview.height,
              }
            : committedSize;
          const isResizePreview = resizePreview != null;
          const renderWorldPosition = resizePreview ?? position;
          const renderPosition = renderedWidgetPosition(
            renderWorldPosition,
            viewport,
            devicePixelRatio,
          );
          const size = previewSize;
          const canvasGestureActive = Boolean(
            resizePreviews[instance.id] ?? dragPositions[instance.id],
          );
          const renderInstance = isResizePreview
            ? {
                ...instance,
                width: previewSize.width,
                height: previewSize.height,
              }
            : instance;
          const widgetInViewport = isHomeCanvasWidgetVisible({
            viewport,
            viewportSize: canvasSize,
            instance: {
              ...renderInstance,
              x: renderWorldPosition.x,
              y: renderWorldPosition.y,
            },
            widgetSizeForInstance,
            viewportLeftOcclusionPx,
          });
          // Scale text against the instance's *active* size profile, not the
          // static catalog default. The clock's digital profile (landscape)
          // differs from its analog default (square); using the catalog default
          // here pinned the digital font to its clamp floor.
          const defaultSize = widgetSizeProfile(instance).defaultSize;
          const widgetScale = Math.min(
            size.width / defaultSize.width,
            size.height / defaultSize.height,
          );
          const widgetTextScale = widgetScale * WIDGET_TEXT_SCALE_MULTIPLIER;
          const widgetStyle = {
            ...renderedWidgetStyle({
              position: renderPosition,
              size,
              zIndex:
                instance.type === "onboardingTour"
                  ? currentMaxZ + 1
                  : (visuallyLiftedZ[instance.id] ?? instance.z),
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
              data-home-widget-id={instance.id}
              draggable={false}
              onPointerDown={(event) => {
                if (instance.id !== focusedCanvasChatId) {
                  setFocusedCanvasChatId(null);
                }
                const expandedCanvasChat =
                  instance.type === "chatPin" &&
                  instance.state?.presentation === "expanded";
                if (
                  expandedCanvasChat &&
                  !(event.target as HTMLElement).closest(
                    HOME_WIDGET_DRAG_HANDLE_SELECTOR,
                  )
                ) {
                  return;
                }
                beginWidgetDrag(event, instance);
              }}
              onDragStart={preventNativeDrag}
              style={widgetStyle}
              className={cn(
                "group/widget",
                animateCameraTransition &&
                  "transition-[left,top] duration-[260ms] ease-out motion-reduce:transition-none",
              )}
            >
              <div
                style={
                  isResizePreview
                    ? renderedWidgetContentStyleForResizePreview({
                        committedSize,
                        previewSize,
                        preserveLayout: Boolean(
                          catalogEntry.sizeBounds.lockAspectRatio,
                        ),
                        zoom: viewport.zoom,
                      })
                    : renderedWidgetContentStyle({
                        size: previewSize,
                        zoom: viewport.zoom,
                      })
                }
              >
                <WidgetFrame
                  instance={renderInstance}
                  constraints={constraints}
                  canvasGestureActive={canvasGestureActive}
                  canvasGestureKind={
                    isResizePreview
                      ? "resize"
                      : dragPositions[instance.id]
                        ? "drag"
                        : undefined
                  }
                  canvasDragPosition={dragPositions[instance.id]}
                  widgetResizePreviewActive={isResizePreview}
                  renderPaused={!widgetInViewport}
                  isCanvasChatFocused={focusedCanvasChatId === instance.id}
                  onFocusCanvasChat={() => setFocusedCanvasChatId(instance.id)}
                  onClearCanvasChatFocus={() =>
                    setFocusedCanvasChatId((current) =>
                      current === instance.id ? null : current,
                    )
                  }
                  onCanvasChatAvailabilityChange={
                    handleCanvasChatAvailabilityChange
                  }
                  currentMaxZ={currentMaxZ}
                  mutations={mutations}
                  shouldIgnoreActivation={
                    dragSuppression.shouldIgnoreActivation
                  }
                  gestureHandlers={dragSuppression.frameHandlers}
                  onVisualLiftReset={handleVisualLiftReset}
                  onOpenAgent={onOpenAgent}
                  onTagAgentInComposer={onTagAgentInComposer}
                  onTagProjectInComposer={onTagProjectInComposer}
                  onTagSkillInComposer={onTagSkillInComposer}
                  onOpenProject={onOpenProject}
                  onOpenSkill={onOpenSkill}
                  onSelectSession={onSelectSession}
                  onStartProjectChat={onStartProjectChat}
                  onOpenAutomation={onOpenAutomation}
                  onRunPrompt={onRunPrompt}
                  onCreatePersona={onCreatePersona}
                  onCreateProject={onCreateProject}
                  onWorkspaceNameRequest={onWorkspaceNameRequest}
                  onOpenSkills={onOpenSkills}
                  onOpenAutomations={onOpenAutomations}
                  onStartOnboardingTour={onStartOnboardingTour}
                  onResolveBerdyAgent={onResolveBerdyAgent}
                />
                {catalogEntry.hideResizeHandle ? null : (
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
                    className={
                      catalogEntry.resizeHandleClassName ??
                      "absolute -right-3 -bottom-3 z-20 hidden size-7 cursor-nwse-resize items-center justify-center rounded-sm group-hover/widget:flex focus-visible:flex focus-visible:ring-2 focus-visible:ring-ring"
                    }
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
                )}
              </div>
            </div>
          );
        })}
      </div>

      {renderRecenterControl ? (
        <div
          className="pointer-events-none absolute inset-0 z-[1000] flex items-center justify-center"
          style={
            viewportLeftOcclusionPx > 0
              ? { left: viewportLeftOcclusionPx }
              : undefined
          }
          aria-hidden={showRecenterControl ? undefined : true}
        >
          <GlassButton
            type="button"
            size="sm"
            className={cn(
              "transition-[opacity,transform] duration-[180ms] ease-out motion-reduce:animate-none motion-reduce:transition-none",
              showRecenterControl
                ? "pointer-events-auto animate-scale-in translate-y-0 scale-100 opacity-100"
                : "pointer-events-none translate-y-1 scale-95 opacity-0",
            )}
            tooltip={resolvedRecenterTitle}
            tabIndex={showRecenterControl ? undefined : -1}
            leftIcon={<Crosshair aria-hidden="true" />}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={showRecenterControl ? onRecenter : undefined}
          >
            {resolvedRecenterLabel}
          </GlassButton>
        </div>
      ) : null}

      <WidgetPicker
        open={picker.open}
        x={picker.x}
        y={picker.y}
        side={picker.side}
        focusOnOpen={picker.focusOnOpen}
        instances={pickerInstances}
        starterTasksAvailable={starterTasksAvailable}
        onClose={closePicker}
        onSelect={(type, state) => {
          clearStarterHomeLayoutEligibility();
          mutations.addWidget(
            type,
            picker.worldX,
            picker.worldY,
            state,
            constraints,
          );
          closePicker();
        }}
        onRestoreStarterTasks={() => {
          onRestoreStarterTasks?.();
          closePicker();
        }}
      />
    </div>
  );
}
