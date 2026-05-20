import { useCallback, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";
import { HOME_WIDGET_CATALOG_BY_ID } from "../widgets/catalog";
import type {
  WidgetInstance,
  WidgetMutationHandlers,
  WidgetNavigationHandlers,
} from "../widgets/types";
import type { WidgetFrameGestureHandlers } from "./useWidgetDragSuppression";

interface WidgetFrameProps extends WidgetNavigationHandlers {
  instance: WidgetInstance;
  currentMaxZ: number;
  mutations: WidgetMutationHandlers;
  shouldIgnoreActivation?: () => boolean;
  gestureHandlers?: Partial<WidgetFrameGestureHandlers>;
  onVisualLiftReset?: (id: string) => void;
}

/**
 * WidgetFrame — widget body + context menu for a single canvas item.
 *
 * The canvas owns gesture disambiguation; the frame coordinates widget chrome,
 * stacking, and menu behavior.
 *
 * Returns null if the catalog entry is missing or has no Component (stubs
 * will be skipped; Task C populates the remaining widget types).
 */
export function WidgetFrame({
  instance,
  currentMaxZ,
  mutations,
  shouldIgnoreActivation = () => false,
  gestureHandlers = {},
  onVisualLiftReset = () => {},
  onOpenAgent,
  onSelectSession,
  onOpenAutomation,
}: WidgetFrameProps) {
  const { t } = useTranslation("home");
  const catalogEntry = HOME_WIDGET_CATALOG_BY_ID[instance.type];
  const { bumpZ, removeWidget, updateWidgetState } = mutations;

  const handleUpdateState = useCallback(
    (next: Record<string, unknown>) => updateWidgetState(instance.id, next),
    [instance.id, updateWidgetState],
  );

  const handleRemove = useCallback(() => {
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

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <fieldset
          aria-label={t(catalogEntry.labelKey)}
          aria-keyshortcuts="Delete Backspace"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: widget frames are keyboard-focusable groups so non-interactive widgets can be removed.
          tabIndex={0}
          onPointerDownCapture={gestureHandlers.onPointerDownCapture}
          onPointerMoveCapture={gestureHandlers.onPointerMoveCapture}
          onPointerUpCapture={gestureHandlers.onPointerUpCapture}
          onPointerCancelCapture={(event) => {
            gestureHandlers.onPointerCancelCapture?.(event);
            resetVisualLift();
          }}
          onContextMenu={commitZLift}
          onClickCapture={gestureHandlers.onClickCapture}
          onClick={commitZLift}
          onKeyDown={handleFrameKeyDown}
          className="m-0 h-full w-full min-w-0 cursor-grab select-none border-0 p-0 [min-inline-size:0] touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background active:cursor-grabbing"
        >
          <Component
            instance={instance}
            onUpdateState={handleUpdateState}
            shouldIgnoreActivation={shouldIgnoreActivation}
            onOpenAgent={onOpenAgent}
            onSelectSession={onSelectSession}
            onOpenAutomation={onOpenAutomation}
          />
        </fieldset>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="z-[1000]"
        onPointerDownCapture={(event) => event.stopPropagation()}
      >
        <ContextMenuItem variant="destructive" onSelect={handleRemove}>
          {t("widgets.actions.unpin")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
