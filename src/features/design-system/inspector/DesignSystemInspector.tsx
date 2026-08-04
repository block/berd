import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  Component,
  Crosshair,
  Maximize2,
  Minimize2,
  Monitor,
  Moon,
  Palette,
  Sun,
  X,
} from "lucide-react";
import { IconLock } from "@tabler/icons-react";

import { keyboardShortcutDisplayParts } from "@/shared/keyboard/keyboardShortcut";
import { getPlatform } from "@/shared/lib/platform";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Separator } from "@/shared/ui/separator";
import {
  collectDesignSystemInspection,
  getElementRect,
  isDesignSystemInspectorTarget,
  type DesignSystemInspection,
} from "./designSystemInspection";
import { useShortcutBindings } from "@/features/shortcuts/lib/shortcutRegistry";

type InspectionRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

type InspectorPosition = {
  top: number;
  left: number;
};

type DragState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startTop: number;
  startLeft: number;
  width: number;
  height: number;
};

type PanelResizeEdge = "top" | "bottom";

type PanelResizeState = DragState & {
  edge: PanelResizeEdge;
};

type DesignSystemInspectorProps = {
  inspectModeToggleRequest?: number;
  onOpenExplorer?: () => void;
};

type InspectModeState = {
  active: boolean;
  lastToggleRequest: number;
};

const INSPECTOR_EDGE_OFFSET = 16;
const INSPECTOR_KEYBOARD_STEP = 12;
const INSPECTOR_DRAG_THRESHOLD = 4;
const INSPECTOR_PANEL_MIN_HEIGHT = 220;
const THEME_MODE_SEQUENCE = ["light", "dark", "system"] as const;

function clampInspectorPosition(
  position: InspectorPosition,
  size: { width: number; height: number },
) {
  const maxLeft = Math.max(
    INSPECTOR_EDGE_OFFSET,
    window.innerWidth - size.width - INSPECTOR_EDGE_OFFSET,
  );
  const maxTop = Math.max(
    INSPECTOR_EDGE_OFFSET,
    window.innerHeight - size.height - INSPECTOR_EDGE_OFFSET,
  );

  return {
    left: Math.min(Math.max(INSPECTOR_EDGE_OFFSET, position.left), maxLeft),
    top: Math.min(Math.max(INSPECTOR_EDGE_OFFSET, position.top), maxTop),
  };
}

function clampInspectorHeight(height: number, top: number) {
  const maxHeight = Math.max(
    INSPECTOR_PANEL_MIN_HEIGHT,
    window.innerHeight - top - INSPECTOR_EDGE_OFFSET,
  );

  return Math.min(Math.max(INSPECTOR_PANEL_MIN_HEIGHT, height), maxHeight);
}

export function DesignSystemInspector({
  inspectModeToggleRequest = 0,
  onOpenExplorer,
}: DesignSystemInspectorProps) {
  const { themeMode, setThemeMode } = useTheme();
  const inspectModeBindings = useShortcutBindings(
    "view.toggleDesignSystemInspectorMode",
  );
  const [{ active, lastToggleRequest }, setInspectModeState] =
    useState<InspectModeState>({
      active: false,
      lastToggleRequest: 0,
    });
  const [hovered, setHovered] = useState<DesignSystemInspection | null>(null);
  const [selectedPath, setSelectedPath] = useState<DesignSystemInspection[]>(
    [],
  );
  const [hoverRect, setHoverRect] = useState<InspectionRect | null>(null);
  const [selectedRect, setSelectedRect] = useState<InspectionRect | null>(null);
  const [controlsPosition, setControlsPosition] =
    useState<InspectorPosition | null>(null);
  const [panelPosition, setPanelPosition] = useState<InspectorPosition | null>(
    null,
  );
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const controlsRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const panelDragStateRef = useRef<DragState | null>(null);
  const panelResizeStateRef = useRef<PanelResizeState | null>(null);
  const suppressNextToggleRef = useRef(false);

  const selected = selectedPath[selectedPath.length - 1] ?? null;
  const visibleInspection = hovered ?? selected;
  const outlineRect = hoverRect ?? selectedRect;
  const visiblePath = useMemo(() => {
    if (!hovered) return selectedPath;
    if (selectedPath.some((item) => item.element === hovered.element)) {
      return selectedPath.slice(
        0,
        selectedPath.findIndex((item) => item.element === hovered.element) + 1,
      );
    }
    return [...selectedPath, hovered];
  }, [hovered, selectedPath]);

  const clearHover = useCallback(() => {
    setHovered(null);
    setHoverRect(null);
  }, []);

  const blurInspectionFocus = useCallback(
    (items: DesignSystemInspection[] = selectedPath) => {
      const activeElement = document.activeElement;
      if (!(activeElement instanceof HTMLElement)) return;
      if (
        items.some((item) => item.element.contains(activeElement)) ||
        activeElement === document.body
      ) {
        activeElement.blur();
      }
    },
    [selectedPath],
  );

  const clearSelection = useCallback(() => {
    blurInspectionFocus();
    setSelectedPath((current) => (current.length ? [] : current));
    setSelectedRect(null);
  }, [blurInspectionFocus]);

  const setActive = useCallback((nextActive: boolean) => {
    setInspectModeState((current) =>
      current.active === nextActive
        ? current
        : { ...current, active: nextActive },
    );
  }, []);

  const selectInspection = useCallback(
    (inspection: DesignSystemInspection) => {
      setSelectedPath((current) => {
        const existingIndex = current.findIndex(
          (item) => item.element === inspection.element,
        );
        if (existingIndex >= 0) {
          return current.slice(0, existingIndex + 1);
        }

        const currentSelection = current[current.length - 1] ?? null;
        if (currentSelection?.element.contains(inspection.element)) {
          return [...current, inspection];
        }

        return [inspection];
      });
      setSelectedRect(getElementRect(inspection.element));
      clearHover();
    },
    [clearHover],
  );

  const stepSelectionBack = useCallback(() => {
    setSelectedPath((current) => {
      blurInspectionFocus(current);

      if (current.length <= 1) {
        setSelectedRect(null);
        return [];
      }

      const nextPath = current.slice(0, -1);
      const nextSelection = nextPath[nextPath.length - 1] ?? null;
      setSelectedRect(getElementRect(nextSelection?.element ?? null));
      return nextPath;
    });
    clearHover();
  }, [blurInspectionFocus, clearHover]);

  const stopInspecting = useCallback(() => {
    setActive(false);
    clearHover();
    clearSelection();
  }, [clearHover, clearSelection, setActive]);

  if (
    inspectModeToggleRequest !== 0 &&
    inspectModeToggleRequest !== lastToggleRequest
  ) {
    setInspectModeState((current) => ({
      active: !current.active,
      lastToggleRequest: inspectModeToggleRequest,
    }));
  }

  const refreshRects = useCallback(() => {
    setHoverRect(getElementRect(hovered?.element ?? null));
    setSelectedRect(getElementRect(selected?.element ?? null));
  }, [hovered, selected]);

  useEffect(() => {
    if (!active) {
      clearHover();
      clearSelection();
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (isDesignSystemInspectorTarget(event.target)) return;

      if (
        selected &&
        (!(event.target instanceof Node) ||
          !selected.element.contains(event.target))
      ) {
        clearHover();
        return;
      }

      const nextInspection = collectDesignSystemInspection(
        event.target,
        selected ? { scope: selected.element } : undefined,
      );
      setHovered(nextInspection);
      setHoverRect(getElementRect(nextInspection?.element ?? null));
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (isDesignSystemInspectorTarget(event.target)) return;

      const isInsideSelected =
        selected &&
        event.target instanceof Node &&
        selected.element.contains(event.target);
      const nextInspection =
        selected && isInsideSelected
          ? collectDesignSystemInspection(event.target, {
              scope: selected.element,
            })
          : collectDesignSystemInspection(event.target);
      if (!nextInspection && !isInsideSelected) return;

      event.preventDefault();
      event.stopPropagation();
    };

    const handleClick = (event: MouseEvent) => {
      if (isDesignSystemInspectorTarget(event.target)) return;

      const isInsideSelected =
        selected &&
        event.target instanceof Node &&
        selected.element.contains(event.target);
      const nextInspection =
        selected && isInsideSelected
          ? collectDesignSystemInspection(event.target, {
              scope: selected.element,
            })
          : collectDesignSystemInspection(event.target);
      if (!nextInspection) {
        if (isInsideSelected) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      selectInspection(nextInspection);
    };

    const clearHoverIfUnlocked = () => {
      if (selected) return;
      clearHover();
    };

    const handlePointerOut = (event: PointerEvent) => {
      if (event.relatedTarget) return;
      clearHoverIfUnlocked();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();

        if (selected) {
          stepSelectionBack();
          return;
        }
        stopInspecting();
      }
    };

    document.addEventListener("pointermove", handlePointerMove, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointerout", handlePointerOut, true);
    document.addEventListener("click", handleClick, true);
    window.addEventListener("blur", clearHoverIfUnlocked);
    // Capture phase so inspect-mode Escape wins over bubble-phase listeners
    // (e.g. the design system view's close-on-Escape) via defaultPrevented.
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("scroll", refreshRects, true);
    window.addEventListener("resize", refreshRects);

    return () => {
      document.removeEventListener("pointermove", handlePointerMove, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointerout", handlePointerOut, true);
      document.removeEventListener("click", handleClick, true);
      window.removeEventListener("blur", clearHoverIfUnlocked);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("scroll", refreshRects, true);
      window.removeEventListener("resize", refreshRects);
    };
  }, [
    active,
    clearHover,
    clearSelection,
    refreshRects,
    selectInspection,
    selected,
    stepSelectionBack,
    stopInspecting,
  ]);

  useEffect(() => {
    const handleResize = () => {
      setControlsPosition((current) => {
        const rect = controlsRef.current?.getBoundingClientRect();
        if (!current || !rect) return current;
        return clampInspectorPosition(current, rect);
      });
      setPanelPosition((current) => {
        const rect = panelRef.current?.getBoundingClientRect();
        if (!current || !rect) return current;
        return clampInspectorPosition(current, rect);
      });
      setPanelHeight((current) => {
        const rect = panelRef.current?.getBoundingClientRect();
        const top = rect?.top ?? panelPosition?.top ?? INSPECTOR_EDGE_OFFSET;
        return current ? clampInspectorHeight(current, top) : current;
      });
    };

    window.addEventListener("resize", handleResize);

    return () => window.removeEventListener("resize", handleResize);
  }, [panelPosition]);

  useEffect(() => {
    if (!visibleInspection) return;

    setPanelPosition((current) => {
      const rect = panelRef.current?.getBoundingClientRect();
      if (!current || !rect) return current;
      return clampInspectorPosition(current, rect);
    });
  }, [visibleInspection]);

  const handlePanelCollapsedChange = useCallback((collapsed: boolean) => {
    setPanelCollapsed(collapsed);
    window.requestAnimationFrame(() => {
      setPanelPosition((current) => {
        const rect = panelRef.current?.getBoundingClientRect();
        if (!current || !rect) return current;
        return clampInspectorPosition(current, rect);
      });
      setPanelHeight((current) => {
        const rect = panelRef.current?.getBoundingClientRect();
        if (!current || !rect) return current;
        return clampInspectorHeight(current, rect.top);
      });
    });
  }, []);

  const moveControlsByKeyboard = useCallback(
    (delta: { top: number; left: number }) => {
      const rect = controlsRef.current?.getBoundingClientRect();
      if (!rect) return;

      setControlsPosition((current) => {
        const base = current ?? { top: rect.top, left: rect.left };
        return clampInspectorPosition(
          {
            top: base.top + delta.top,
            left: base.left + delta.left,
          },
          rect,
        );
      });
    },
    [],
  );

  const movePanelByKeyboard = useCallback(
    (delta: { top: number; left: number }) => {
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;

      setPanelPosition((current) => {
        const base = current ?? { top: rect.top, left: rect.left };
        return clampInspectorPosition(
          {
            top: base.top + delta.top,
            left: base.left + delta.left,
          },
          rect,
        );
      });
    },
    [],
  );

  const handleDragStart = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0) return;

    const rect = controlsRef.current?.getBoundingClientRect();
    if (!rect) return;

    dragStateRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startTop: rect.top,
      startLeft: rect.left,
      width: rect.width,
      height: rect.height,
    };
    setControlsPosition({ top: rect.top, left: rect.left });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleDragMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    setControlsPosition(
      clampInspectorPosition(
        {
          top: dragState.startTop + event.clientY - dragState.startClientY,
          left: dragState.startLeft + event.clientX - dragState.startClientX,
        },
        dragState,
      ),
    );
  };

  const handleDragEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current;
    if (dragState?.pointerId !== event.pointerId) return;
    dragStateRef.current = null;

    const draggedDistance = Math.hypot(
      event.clientX - dragState.startClientX,
      event.clientY - dragState.startClientY,
    );
    suppressNextToggleRef.current = draggedDistance > INSPECTOR_DRAG_THRESHOLD;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleDragKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Home") {
      event.preventDefault();
      setControlsPosition(null);
      return;
    }

    const movementByKey: Record<string, { top: number; left: number }> = {
      ArrowUp: { top: -INSPECTOR_KEYBOARD_STEP, left: 0 },
      ArrowRight: { top: 0, left: INSPECTOR_KEYBOARD_STEP },
      ArrowDown: { top: INSPECTOR_KEYBOARD_STEP, left: 0 },
      ArrowLeft: { top: 0, left: -INSPECTOR_KEYBOARD_STEP },
    };
    const movement = movementByKey[event.key];
    if (!movement) return;

    event.preventDefault();
    moveControlsByKeyboard(movement);
  };

  const handlePanelDragStart = (event: ReactPointerEvent<HTMLElement>) => {
    if (!event.isPrimary || event.button !== 0) return;

    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;

    panelDragStateRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startTop: rect.top,
      startLeft: rect.left,
      width: rect.width,
      height: rect.height,
    };
    setPanelPosition({ top: rect.top, left: rect.left });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePanelDragMove = (event: ReactPointerEvent<HTMLElement>) => {
    const dragState = panelDragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    setPanelPosition(
      clampInspectorPosition(
        {
          top: dragState.startTop + event.clientY - dragState.startClientY,
          left: dragState.startLeft + event.clientX - dragState.startClientX,
        },
        dragState,
      ),
    );
  };

  const handlePanelDragEnd = (event: ReactPointerEvent<HTMLElement>) => {
    const dragState = panelDragStateRef.current;
    if (dragState?.pointerId !== event.pointerId) return;
    panelDragStateRef.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handlePanelDragKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (event.key === "Home") {
      event.preventDefault();
      setPanelPosition(null);
      return;
    }

    const movementByKey: Record<string, { top: number; left: number }> = {
      ArrowUp: { top: -INSPECTOR_KEYBOARD_STEP, left: 0 },
      ArrowRight: { top: 0, left: INSPECTOR_KEYBOARD_STEP },
      ArrowDown: { top: INSPECTOR_KEYBOARD_STEP, left: 0 },
      ArrowLeft: { top: 0, left: -INSPECTOR_KEYBOARD_STEP },
    };
    const movement = movementByKey[event.key];
    if (!movement) return;

    event.preventDefault();
    movePanelByKeyboard(movement);
  };

  const handlePanelResizeStart =
    (edge: PanelResizeEdge) => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!event.isPrimary || event.button !== 0) return;

      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;

      panelResizeStateRef.current = {
        edge,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startTop: rect.top,
        startLeft: rect.left,
        width: rect.width,
        height: rect.height,
      };
      setPanelPosition({ top: rect.top, left: rect.left });
      setPanelHeight(rect.height);
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
    };

  const handlePanelResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = panelResizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;

    const deltaY = event.clientY - resizeState.startClientY;

    if (resizeState.edge === "bottom") {
      setPanelHeight(
        clampInspectorHeight(resizeState.height + deltaY, resizeState.startTop),
      );
      return;
    }

    const bottom = resizeState.startTop + resizeState.height;
    const unclampedTop = resizeState.startTop + deltaY;
    const maxTop = bottom - INSPECTOR_PANEL_MIN_HEIGHT;
    const nextTop = Math.min(
      Math.max(INSPECTOR_EDGE_OFFSET, unclampedTop),
      maxTop,
    );

    setPanelPosition({ top: nextTop, left: resizeState.startLeft });
    setPanelHeight(bottom - nextTop);
  };

  const handlePanelResizeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = panelResizeStateRef.current;
    if (resizeState?.pointerId !== event.pointerId) return;
    panelResizeStateRef.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const isMac = getPlatform() === "mac";
  const inspectModeShortcut =
    inspectModeBindings[0]?.shortcut ?? (isMac ? "meta+i" : "ctrl+i");
  const inspectModeShortcutLabel = keyboardShortcutDisplayParts(
    inspectModeShortcut,
    isMac,
  ).join(isMac ? "" : "+");
  const toggleLabel = `${active ? "Inspecting" : "Inspect"} (${inspectModeShortcutLabel})`;
  const nextThemeMode =
    THEME_MODE_SEQUENCE[
      (THEME_MODE_SEQUENCE.indexOf(themeMode) + 1) % THEME_MODE_SEQUENCE.length
    ];
  const ThemeModeIcon =
    themeMode === "light" ? Sun : themeMode === "dark" ? Moon : Monitor;
  const themeModeLabel =
    themeMode === "light" ? "Light" : themeMode === "dark" ? "Dark" : "System";
  const nextThemeModeLabel =
    nextThemeMode === "light"
      ? "light"
      : nextThemeMode === "dark"
        ? "dark"
        : "system";
  const handleToggleClick = () => {
    if (suppressNextToggleRef.current) {
      suppressNextToggleRef.current = false;
      return;
    }

    if (active) {
      stopInspecting();
      return;
    }

    setActive(true);
  };
  const controlsStyle = controlsPosition
    ? {
        top: controlsPosition.top,
        left: controlsPosition.left,
      }
    : undefined;
  const panelStyle: CSSProperties | undefined =
    panelPosition || panelHeight
      ? {
          ...(panelPosition
            ? { top: panelPosition.top, left: panelPosition.left }
            : {}),
          ...(panelHeight && !panelCollapsed ? { height: panelHeight } : {}),
        }
      : undefined;
  const visibleInspectionLocked = Boolean(
    selected && visibleInspection?.element === selected.element,
  );

  return (
    <div data-design-system-inspector="root">
      {outlineRect ? (
        <InspectorOutline rect={outlineRect} locked={visibleInspectionLocked} />
      ) : null}

      <div
        ref={controlsRef}
        className={
          controlsPosition
            ? "fixed z-[120] flex items-center gap-2"
            : "fixed bottom-4 left-4 z-[120] flex items-center gap-2"
        }
        style={controlsStyle}
      >
        {selected ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            leftIcon={<X aria-hidden="true" />}
            onClick={clearSelection}
          >
            Clear
          </Button>
        ) : null}
        <Button
          type="button"
          variant={active ? "primary" : "subtle"}
          size="sm"
          leftIcon={<Crosshair aria-hidden="true" />}
          className="cursor-grab touch-none active:cursor-grabbing"
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
          onKeyDown={handleDragKeyDown}
          onClick={handleToggleClick}
          aria-pressed={active}
        >
          {toggleLabel}
        </Button>
        <Button
          type="button"
          variant="subtle"
          size="icon-sm"
          aria-label={`${themeModeLabel} theme. Switch to ${nextThemeModeLabel} theme`}
          onClick={() => setThemeMode(nextThemeMode)}
        >
          <ThemeModeIcon aria-hidden="true" />
        </Button>
        {onOpenExplorer ? (
          <Button
            type="button"
            variant="subtle"
            size="icon-sm"
            aria-label="Open design system explorer"
            tooltip="Open design system explorer"
            onClick={onOpenExplorer}
          >
            <Palette aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      {active && visibleInspection ? (
        <InspectorPanel
          panelRef={panelRef}
          inspection={visibleInspection}
          path={visiblePath}
          locked={visibleInspectionLocked}
          collapsed={panelCollapsed}
          position={panelPosition}
          style={panelStyle}
          onDragStart={handlePanelDragStart}
          onDragMove={handlePanelDragMove}
          onDragEnd={handlePanelDragEnd}
          onDragKeyDown={handlePanelDragKeyDown}
          onResizeStart={handlePanelResizeStart}
          onResizeMove={handlePanelResizeMove}
          onResizeEnd={handlePanelResizeEnd}
          onCollapsedChange={handlePanelCollapsedChange}
          onClose={stopInspecting}
        />
      ) : null}
    </div>
  );
}

function InspectorOutline({
  rect,
  locked,
}: {
  rect: InspectionRect;
  locked: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed z-[110] rounded-sm border border-ring bg-info/10 shadow-mini"
      style={{
        top: rect.top - 2,
        left: rect.left - 2,
        width: rect.width + 4,
        height: rect.height + 4,
        outline: locked ? "2px solid var(--primary)" : "1px solid transparent",
      }}
    />
  );
}

function getInspectionCrumbLabel(inspection: DesignSystemInspection) {
  return (
    inspection.slot ??
    inspection.component ??
    inspection.role ??
    inspection.ariaLabel ??
    inspection.tagName
  );
}

function getInspectionCrumbKey(inspection: DesignSystemInspection) {
  return [
    inspection.component,
    inspection.slot,
    inspection.source,
    inspection.tagName,
    inspection.role,
    inspection.ariaLabel,
    inspection.textSnippet,
  ]
    .filter(Boolean)
    .join(":");
}

function InspectorPanel({
  panelRef,
  inspection,
  path,
  locked,
  collapsed,
  position,
  style,
  onDragStart,
  onDragMove,
  onDragEnd,
  onDragKeyDown,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  onCollapsedChange,
  onClose,
}: {
  panelRef: RefObject<HTMLElement | null>;
  inspection: DesignSystemInspection;
  path: DesignSystemInspection[];
  locked: boolean;
  collapsed: boolean;
  position: InspectorPosition | null;
  style: CSSProperties | undefined;
  onDragStart: (event: ReactPointerEvent<HTMLElement>) => void;
  onDragMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onDragEnd: (event: ReactPointerEvent<HTMLElement>) => void;
  onDragKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onResizeStart: (
    edge: PanelResizeEdge,
  ) => (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeEnd: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onCollapsedChange: (collapsed: boolean) => void;
  onClose: () => void;
}) {
  const propEntries = Object.entries(inspection.props);
  const classPreview = useMemo(
    () => inspection.classNames.slice(0, 18),
    [inspection.classNames],
  );
  const pathPreview = useMemo(
    () =>
      path.slice(-4).map((item) => ({
        key: getInspectionCrumbKey(item),
        label: getInspectionCrumbLabel(item),
      })),
    [path],
  );

  return (
    <aside
      ref={panelRef}
      className={
        position
          ? collapsed
            ? "fixed z-[120] flex max-h-[calc(100vh-2rem)] w-[320px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-md border border-border bg-popover text-foreground shadow-popover"
            : "fixed z-[120] flex max-h-[calc(100vh-2rem)] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-md border border-border bg-popover text-foreground shadow-popover"
          : collapsed
            ? "fixed top-16 right-4 z-[120] flex max-h-[calc(100vh-8rem)] w-[320px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-md border border-border bg-popover text-foreground shadow-popover"
            : "fixed top-16 right-4 z-[120] flex max-h-[calc(100vh-8rem)] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-md border border-border bg-popover text-foreground shadow-popover"
      }
      style={style}
    >
      {collapsed ? null : (
        <PanelResizeHandle
          edge="top"
          onPointerDown={onResizeStart("top")}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
        />
      )}
      <header className="flex items-stretch border-b border-border">
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-grab touch-none flex-col bg-transparent py-2.5 pr-3 pl-4 text-left text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover active:cursor-grabbing"
          aria-label="Move inspector panel"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          onKeyDown={onDragKeyDown}
        >
          <span className="flex min-h-7 min-w-0 items-center gap-2">
            <span className="truncate font-normal text-base">
              {inspection.label}
            </span>
            {locked ? (
              <span className="inline-flex items-center text-muted-foreground/70">
                <IconLock className="size-3.5" aria-hidden="true" />
                <span className="sr-only">Locked</span>
              </span>
            ) : null}
          </span>
          <span className="block min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            {inspection.source ?? `${inspection.tagName} element`}
          </span>
          {pathPreview.length > 1 ? (
            <span className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
              {path.length > pathPreview.length ? (
                <span aria-hidden="true">...</span>
              ) : null}
              {pathPreview.map(({ key, label }, index) => (
                <span
                  key={key}
                  className="inline-flex min-w-0 items-center gap-1"
                >
                  {index > 0 ? <span aria-hidden="true">/</span> : null}
                  <span className="max-w-24 truncate font-mono">{label}</span>
                </span>
              ))}
            </span>
          ) : null}
        </button>
        <div className="flex min-h-12 items-center py-2.5 pr-3">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            aria-label={
              collapsed ? "Expand inspector panel" : "Collapse inspector panel"
            }
            aria-expanded={!collapsed}
            onClick={() => onCollapsedChange(!collapsed)}
          >
            {collapsed ? (
              <Maximize2 aria-hidden="true" />
            ) : (
              <Minimize2 aria-hidden="true" />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            aria-label="Close inspector"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      </header>

      {collapsed ? null : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <InspectorSection icon={<Component />} title="Component">
            <DefinitionList
              rows={[
                ["component", inspection.component ?? "Unknown"],
                ["slot", inspection.slot ?? "none"],
                ["tag", inspection.tagName],
                ["variant", inspection.variant ?? "default"],
                ["size", inspection.size ?? "default"],
              ]}
            />
            {propEntries.length ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {propEntries.map(([key, value]) => (
                  <Badge key={key} variant="outline">
                    {key}: {String(value)}
                  </Badge>
                ))}
              </div>
            ) : null}
          </InspectorSection>

          <Separator className="my-3" />

          <InspectorSection icon={<Palette />} title="Styling">
            <FindingList findings={inspection.findings} />
            {inspection.semanticClasses.length ? (
              <TokenClassList
                values={inspection.semanticClasses.slice(0, 16)}
              />
            ) : null}
          </InspectorSection>

          <Separator className="my-3" />

          <InspectorSection icon={<Code2 />} title="Rendered Element">
            <DefinitionList
              rows={[
                ["role", inspection.role ?? "none"],
                ["aria-label", inspection.ariaLabel ?? "none"],
                ["text", inspection.textSnippet ?? "none"],
              ]}
            />
            {classPreview.length ? (
              <div className="mt-3 rounded-md border border-border bg-background px-2 py-2">
                <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                  class list
                </p>
                <div className="flex flex-wrap gap-1">
                  {classPreview.map((className) => (
                    <span
                      key={className}
                      className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                    >
                      {className}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </InspectorSection>

          <Separator className="my-3" />

          <InspectorSection icon={<Palette />} title="Computed">
            <DefinitionList
              rows={inspection.computed.map((item) => [item.label, item.value])}
            />
          </InspectorSection>
        </div>
      )}
      {collapsed ? null : (
        <PanelResizeHandle
          edge="bottom"
          onPointerDown={onResizeStart("bottom")}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
        />
      )}
    </aside>
  );
}

function PanelResizeHandle({
  edge,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: {
  edge: PanelResizeEdge;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      aria-hidden="true"
      className={
        edge === "top"
          ? "absolute top-0 right-0 left-0 z-10 h-2 cursor-row-resize touch-none"
          : "absolute right-0 bottom-0 left-0 z-10 h-2 cursor-row-resize touch-none"
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    />
  );
}

function InspectorSection({
  icon,
  title,
  children,
}: {
  icon: ReactElement;
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-1.5 text-sm font-normal text-foreground [&_svg]:size-3.5">
        {icon}
        <span>{title}</span>
      </div>
      {children}
    </section>
  );
}

function DefinitionList({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="grid gap-1.5 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words font-mono text-[11px] text-foreground">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function FindingList({
  findings,
}: {
  findings: DesignSystemInspection["findings"];
}) {
  return (
    <div className="grid gap-2">
      {findings.map((finding) => {
        const Icon = finding.tone === "warning" ? AlertTriangle : CheckCircle2;
        return (
          <div
            key={finding.text}
            className="flex gap-2 rounded-md border border-border bg-background px-2.5 py-2 text-xs"
          >
            <Icon
              className={
                finding.tone === "warning"
                  ? "mt-0.5 size-3.5 shrink-0 text-warning"
                  : "mt-0.5 size-3.5 shrink-0 text-success"
              }
              aria-hidden="true"
            />
            <p className="min-w-0 break-words text-foreground">
              {finding.text}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function TokenClassList({ values }: { values: string[] }) {
  return (
    <div className="mt-3">
      <p className="mb-1 text-[11px] font-medium text-muted-foreground">
        token-like classes
      </p>
      <div className="flex flex-wrap gap-1">
        {values.map((value) => (
          <Badge key={value} variant="secondary">
            {value}
          </Badge>
        ))}
      </div>
    </div>
  );
}
