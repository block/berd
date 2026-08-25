import {
  useCallback,
  useEffect,
  useState,
  type AnimationEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { LayoutConstraints } from "@/features/layout/api/layout";
import type { WorkspaceNameRequest } from "@/features/chat/hooks/useChatSessionController";
import { cn } from "@/shared/lib/cn";
import {
  consumeFreshWidgetPlacement,
  hasFreshWidgetPlacement,
} from "../lib/freshWidgetPlacements";
import { clearStarterHomeLayoutEligibility } from "@/features/home/onboarding/starterHomeLayout";
import { HOME_WIDGET_CATALOG_BY_ID } from "../widgets/catalog";
import type {
  WidgetInstance,
  WidgetMutationHandlers,
  WidgetNavigationHandlers,
} from "../widgets/types";
import { UnpinPill } from "./UnpinPill";
import type { WidgetFrameGestureHandlers } from "./useWidgetDragSuppression";

interface WidgetFrameProps extends WidgetNavigationHandlers {
  instance: WidgetInstance;
  currentMaxZ: number;
  mutations: WidgetMutationHandlers;
  constraints?: LayoutConstraints | null;
  canvasGestureActive?: boolean;
  canvasGestureKind?: "drag" | "resize";
  canvasDragPosition?: { x: number; y: number };
  widgetResizePreviewActive?: boolean;
  renderPaused?: boolean;
  isCanvasChatFocused?: boolean;
  onFocusCanvasChat?: () => void;
  onClearCanvasChatFocus?: () => void;
  onCanvasChatAvailabilityChange?: (
    widgetId: string,
    available: boolean,
  ) => void;
  onWorkspaceNameRequest?: (request: WorkspaceNameRequest) => void;
  shouldIgnoreActivation?: () => boolean;
  gestureHandlers?: Partial<WidgetFrameGestureHandlers>;
  onVisualLiftReset?: (id: string) => void;
}

interface UnpinPillState {
  open: boolean;
  x: number;
  y: number;
}

const CLOSED_PILL: UnpinPillState = { open: false, x: 0, y: 0 };

/**
 * WidgetFrame — widget body + UnpinPill for a single canvas item.
 *
 * The canvas owns gesture disambiguation; the frame coordinates widget chrome,
 * stacking, and the right-click unpin affordance. Returns null if the catalog
 * entry is missing or has no Component (stubs will be skipped).
 */
export function WidgetFrame({
  instance,
  currentMaxZ,
  mutations,
  constraints,
  canvasGestureActive = false,
  canvasGestureKind,
  canvasDragPosition,
  widgetResizePreviewActive = false,
  renderPaused = false,
  isCanvasChatFocused = false,
  onFocusCanvasChat,
  onClearCanvasChatFocus,
  onCanvasChatAvailabilityChange,
  shouldIgnoreActivation = () => false,
  gestureHandlers = {},
  onVisualLiftReset = () => {},
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
}: WidgetFrameProps) {
  const { t } = useTranslation("home");
  const catalogEntry = HOME_WIDGET_CATALOG_BY_ID[instance.type];
  const { bumpZ, removeWidget, updateWidgetState } = mutations;
  const [pill, setPill] = useState<UnpinPillState>(CLOSED_PILL);

  // Play the "set down" placement animation only when this instance was just
  // created interactively — returning to Home or reloading the layout must
  // not replay it. The initializer is a pure read (StrictMode runs it twice
  // and may discard a render); the one-shot entry is consumed in the mount
  // effect below, which only runs for committed mounts.
  const [justPlaced, setJustPlaced] = useState(() =>
    hasFreshWidgetPlacement(instance.id),
  );
  useEffect(() => {
    consumeFreshWidgetPlacement(instance.id);
  }, [instance.id]);

  const handleSettleAnimationEnd = useCallback(
    (event: AnimationEvent<HTMLFieldSetElement>) => {
      // animationend bubbles: a child widget's own animation (e.g. the
      // clock's face fade at 180ms) must not cancel the 380ms settle
      // mid-overshoot. Only the fieldset's own animation ends the state.
      if (event.target === event.currentTarget) {
        setJustPlaced(false);
      }
    },
    [],
  );

  const handleUpdateState = useCallback(
    (next: Record<string, unknown>) => {
      clearStarterHomeLayoutEligibility();
      updateWidgetState(instance.id, next, constraints ?? undefined);
    },
    [constraints, instance.id, updateWidgetState],
  );

  const handleRemove = useCallback(() => {
    clearStarterHomeLayoutEligibility();
    removeWidget(instance.id);
  }, [instance.id, removeWidget]);

  const handleFrameKeyDown = useCallback(
    (event: KeyboardEvent<HTMLFieldSetElement>) => {
      if (
        event.target === event.currentTarget &&
        (event.key === "Delete" || event.key === "Backspace")
      ) {
        event.preventDefault();
        event.stopPropagation();
        handleRemove();
      }
    },
    [handleRemove],
  );

  if (!catalogEntry?.Component) {
    return null;
  }

  const { Component } = catalogEntry;
  const isBehindTopWidget = instance.z < currentMaxZ;

  const resetVisualLift = () => {
    if (isBehindTopWidget) {
      onVisualLiftReset(instance.id);
    }
  };

  const commitZLift = () => {
    if (isBehindTopWidget) {
      bumpZ(instance.id);
    }
  };

  // Mouse-only right-click trigger. Pre-Task-4 the Radix ContextMenuTrigger
  // handled Shift+F10 / Menu-key natively; we dropped that path to match the
  // spec's explicit "right-click" UX. If keyboard parity is needed later,
  // wire a separate keydown handler — do not re-introduce Radix ContextMenu.
  const handleContextMenu = (event: MouseEvent<HTMLFieldSetElement>) => {
    // Suppress the native browser menu AND prevent the canvas-level
    // onContextMenu from also opening the pin picker behind the pill.
    event.preventDefault();
    event.stopPropagation();
    setPill({ open: true, x: event.clientX, y: event.clientY });
  };

  const handlePillOpenChange = (open: boolean) => {
    if (!open) {
      setPill(CLOSED_PILL);
    }
  };

  return (
    <>
      <fieldset
        aria-label={t(catalogEntry.labelKey)}
        aria-keyshortcuts="Delete Backspace"
        draggable={false}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: widget frames are keyboard-focusable groups so non-interactive widgets can be removed.
        tabIndex={0}
        onPointerDownCapture={gestureHandlers.onPointerDownCapture}
        onPointerMoveCapture={gestureHandlers.onPointerMoveCapture}
        onPointerUpCapture={gestureHandlers.onPointerUpCapture}
        onPointerCancelCapture={(event) => {
          gestureHandlers.onPointerCancelCapture?.(event);
          resetVisualLift();
        }}
        onContextMenu={handleContextMenu}
        onDragStart={(event) => event.preventDefault()}
        onClickCapture={gestureHandlers.onClickCapture}
        onClick={commitZLift}
        onKeyDown={handleFrameKeyDown}
        onAnimationEnd={handleSettleAnimationEnd}
        className={cn(
          "m-0 h-full w-full min-w-0 cursor-grab select-none border-0 p-0 [min-inline-size:0] touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing",
          justPlaced && "animate-widget-settle",
        )}
      >
        <Component
          instance={instance}
          canvasGestureActive={canvasGestureActive}
          canvasGestureKind={canvasGestureKind}
          canvasDragPosition={canvasDragPosition}
          widgetResizePreviewActive={widgetResizePreviewActive}
          renderPaused={renderPaused}
          onUpdateState={handleUpdateState}
          shouldIgnoreActivation={shouldIgnoreActivation}
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
          isCanvasChatFocused={isCanvasChatFocused}
          onFocusCanvasChat={onFocusCanvasChat}
          onClearCanvasChatFocus={onClearCanvasChatFocus}
          onCanvasChatAvailabilityChange={onCanvasChatAvailabilityChange}
          onOpenSkills={onOpenSkills}
          onOpenAutomations={onOpenAutomations}
          onStartOnboardingTour={onStartOnboardingTour}
          onResolveBerdyAgent={onResolveBerdyAgent}
          onRemoveWidget={handleRemove}
        />
      </fieldset>
      <UnpinPill
        open={pill.open}
        cursorClientX={pill.x}
        cursorClientY={pill.y}
        onUnpin={handleRemove}
        onOpenChange={handlePillOpenChange}
      />
    </>
  );
}
