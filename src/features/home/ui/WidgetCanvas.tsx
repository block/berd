import type React from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { HOME_WIDGET_CATALOG_BY_ID } from "../widgets/catalog";
import type {
  CanvasBounds,
  WidgetInstance,
  WidgetNavigationHandlers,
} from "../widgets/types";
import { useHomeWidgetStore } from "../stores/homeWidgetStore";
import { WidgetFrame } from "./WidgetFrame";
import { WidgetPicker } from "./WidgetPicker";

interface WidgetCanvasProps extends WidgetNavigationHandlers {
  instances: WidgetInstance[];
}

interface PickerState {
  open: boolean;
  x: number;
  y: number;
}

/**
 * WidgetCanvas — the free-form widget layer.
 *
 * Double-clicking the canvas background opens the WidgetPicker at the cursor
 * position. Only instances whose catalog entry has a Component are rendered;
 * stubs (Task C) are silently skipped until their Component is supplied.
 */
export function WidgetCanvas({
  instances,
  onOpenAgent,
  onSelectSession,
  onOpenAutomation,
}: WidgetCanvasProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const addWidget = useHomeWidgetStore((state) => state.addWidget);
  const [picker, setPicker] = useState<PickerState>({
    open: false,
    x: 0,
    y: 0,
  });

  const getCanvasBounds = useCallback((): CanvasBounds | undefined => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect ? { width: rect.width, height: rect.height } : undefined;
  }, []);

  const currentMaxZ = useMemo(
    () => instances.reduce((max, instance) => Math.max(max, instance.z), 0),
    [instances],
  );

  const openPickerAt = useCallback((x: number, y: number) => {
    setPicker({ open: true, x, y });
  }, []);

  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    openPickerAt(event.clientX - rect.left, event.clientY - rect.top);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: freeform spatial canvas — double-click is the only interaction, no semantic element fits
    <div
      ref={canvasRef}
      onDoubleClick={handleDoubleClick}
      className="relative h-full w-full overflow-hidden bg-dot-grid"
    >
      <AnimatePresence initial={false}>
        {instances
          .filter(
            (instance) => HOME_WIDGET_CATALOG_BY_ID[instance.type]?.Component,
          )
          .map((instance) => (
            <WidgetFrame
              key={instance.id}
              instance={instance}
              canvasRef={canvasRef}
              currentMaxZ={currentMaxZ}
              getCanvasBounds={getCanvasBounds}
              onOpenAgent={onOpenAgent}
              onSelectSession={onSelectSession}
              onOpenAutomation={onOpenAutomation}
            />
          ))}
      </AnimatePresence>

      <WidgetPicker
        open={picker.open}
        x={picker.x}
        y={picker.y}
        onClose={() => setPicker((current) => ({ ...current, open: false }))}
        onSelect={(type, state) => {
          addWidget(type, picker.x, picker.y, state, getCanvasBounds());
          setPicker((current) => ({ ...current, open: false }));
        }}
      />
    </div>
  );
}
