import type { RefObject } from "react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";
import { HOME_WIDGET_CATALOG_BY_ID } from "../widgets/catalog";
import type {
  CanvasBounds,
  WidgetInstance,
  WidgetMutationHandlers,
  WidgetNavigationHandlers,
} from "../widgets/types";
import { useWidgetDragSuppression } from "./useWidgetDragSuppression";

interface WidgetFrameProps extends WidgetNavigationHandlers {
  instance: WidgetInstance;
  canvasRef: RefObject<HTMLDivElement | null>;
  currentMaxZ: number;
  getCanvasBounds: () => CanvasBounds | undefined;
  mutations: WidgetMutationHandlers;
}

/**
 * WidgetFrame — drag shell + context menu for a single widget instance.
 *
 * Handles pointer/drag disambiguation so widgets that contain interactive
 * elements (buttons, links) don't fire click handlers after a drag gesture.
 * The full click-suppression apparatus is intentional; do not simplify it.
 *
 * Returns null if the catalog entry is missing or has no Component (stubs
 * will be skipped; Task C populates the remaining widget types).
 */
export function WidgetFrame({
  instance,
  canvasRef,
  currentMaxZ,
  getCanvasBounds,
  mutations,
  onOpenAgent,
  onSelectSession,
  onOpenAutomation,
}: WidgetFrameProps) {
  const { t } = useTranslation("home");
  const {
    shouldIgnoreActivation,
    handleDragStart,
    handleDragEnd,
    handlePointerDownCapture,
    handlePointerMoveCapture,
    handlePointerUpCapture,
    handleClickCapture,
  } = useWidgetDragSuppression();

  const catalogEntry = HOME_WIDGET_CATALOG_BY_ID[instance.type];
  const updateWidgetState = mutations.updateWidgetState;

  const handleUpdateState = useCallback(
    (next: Record<string, unknown>) => updateWidgetState(instance.id, next),
    [instance.id, updateWidgetState],
  );

  if (!catalogEntry?.Component) {
    return null;
  }

  const { Component } = catalogEntry;
  const isBehindTopWidget = instance.z < currentMaxZ;

  const liftVisually = (element: HTMLElement) => {
    if (isBehindTopWidget) {
      element.style.zIndex = String(currentMaxZ + 1);
    }
  };

  const resetVisualLift = (element: HTMLElement) => {
    if (isBehindTopWidget) {
      element.style.zIndex = String(instance.z);
    }
  };

  const commitZLift = () => {
    if (isBehindTopWidget) {
      mutations.bumpZ(instance.id);
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <motion.div
          drag
          dragConstraints={canvasRef}
          dragElastic={0}
          dragMomentum={false}
          initial={false}
          exit={{ opacity: 0 }}
          transition={{ type: "spring", stiffness: 430, damping: 32 }}
          onDragStart={handleDragStart}
          onPointerDownCapture={(event) => {
            handlePointerDownCapture(event);
            liftVisually(event.currentTarget);
          }}
          onPointerMoveCapture={handlePointerMoveCapture}
          onPointerUpCapture={handlePointerUpCapture}
          onPointerCancelCapture={(event) => {
            resetVisualLift(event.currentTarget);
          }}
          onContextMenu={commitZLift}
          onDragEnd={(_, info) => {
            handleDragEnd(info.offset);
            commitZLift();
            mutations.moveWidget(
              instance.id,
              instance.x + info.offset.x,
              instance.y + info.offset.y,
              getCanvasBounds(),
            );
          }}
          onClickCapture={(event) => {
            handleClickCapture(event);
          }}
          onClick={commitZLift}
          style={{
            x: instance.x,
            y: instance.y,
            zIndex: instance.z,
            width: catalogEntry.defaultSize.width,
            height: catalogEntry.defaultSize.height,
          }}
          className="absolute left-0 top-0 cursor-grab select-none touch-none active:cursor-grabbing"
        >
          <Component
            instance={instance}
            onUpdateState={handleUpdateState}
            shouldIgnoreActivation={shouldIgnoreActivation}
            onOpenAgent={onOpenAgent}
            onSelectSession={onSelectSession}
            onOpenAutomation={onOpenAutomation}
          />
        </motion.div>
      </ContextMenuTrigger>
      <ContextMenuContent className="z-[1000]">
        <ContextMenuItem
          variant="destructive"
          onSelect={() => mutations.removeWidget(instance.id)}
        >
          {t("widgets.actions.remove")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
