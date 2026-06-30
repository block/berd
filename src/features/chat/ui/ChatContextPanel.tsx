import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { cn } from "@/shared/lib/cn";
import { ContextPanel } from "./ContextPanel";
import { useFocusRegion } from "@/app/focus/FocusRegionProvider";

const CP_PANEL_W = 315;
export const CP_TOTAL_W = CP_PANEL_W;
const CP_FADE_S = 0.15;
const CP_REFLOW_MS = 200;
export const CHAT_CONTEXT_PANEL_COMPACT_BASE_WIDTH = 800;

export function getChatContextPanelCompactQuery(leftViewportOcclusionPx = 0) {
  const compactWidth =
    CHAT_CONTEXT_PANEL_COMPACT_BASE_WIDTH +
    Math.max(0, Math.round(leftViewportOcclusionPx));
  return `(max-width: ${compactWidth}px)`;
}

export const CHAT_CONTEXT_PANEL_COMPACT_QUERY =
  getChatContextPanelCompactQuery();

export function useChatContextPanelCompactViewport(
  leftViewportOcclusionPx = 0,
) {
  const compactQuery = useMemo(
    () => getChatContextPanelCompactQuery(leftViewportOcclusionPx),
    [leftViewportOcclusionPx],
  );
  const [isCompactViewport, setIsCompactViewport] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return false;
    }
    return window.matchMedia(compactQuery).matches;
  });

  useEffect(() => {
    if (!window.matchMedia) return;

    const mediaQuery = window.matchMedia(compactQuery);
    setIsCompactViewport(mediaQuery.matches);

    const handleChange = (event: MediaQueryListEvent) => {
      setIsCompactViewport(event.matches);
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [compactQuery]);

  return isCompactViewport;
}

interface ChatContextPanelProps {
  activeSessionId: string;
  isOpen: boolean;
  project?: {
    id?: string;
    name?: string;
    icon?: string;
    color?: string;
    workingDirs?: string[];
  } | null;
  sessionWorkingDir?: string | null;
  terminalOpen?: boolean;
  panelWidth?: number;
  allowVerticalShrink?: boolean;
  widthTransitionEnabled?: boolean;
  leftViewportOcclusionPx?: number;
  onRequestClose?: () => void;
  onToggleTerminal?: () => void;
}

export function ChatContextPanel({
  activeSessionId,
  isOpen,
  project,
  sessionWorkingDir,
  terminalOpen = false,
  panelWidth = CP_TOTAL_W,
  allowVerticalShrink = false,
  widthTransitionEnabled = true,
  leftViewportOcclusionPx = 0,
  onRequestClose,
  onToggleTerminal,
}: ChatContextPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const shouldReduceMotion = useReducedMotion();
  const isCompactViewport = useChatContextPanelCompactViewport(
    leftViewportOcclusionPx,
  );
  const previousCompactViewportRef = useRef(isCompactViewport);
  const dockingTimerRef = useRef<number | null>(null);
  const [panelElement, setPanelElement] = useState<HTMLDivElement | null>(null);
  const [isDockingFromCompact, setIsDockingFromCompact] = useState(false);
  const fadeTransition = { duration: shouldReduceMotion ? 0 : CP_FADE_S };
  const reflowDuration = shouldReduceMotion ? 0 : CP_REFLOW_MS;
  const handlePanelRef = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    setPanelElement(node);
  }, []);
  useFocusRegion({
    id: "context",
    label: "context",
    key: "x",
    enabled: isOpen,
    element: panelElement,
    getInitialFocus: () =>
      panelElement?.querySelector<HTMLElement>(
        "button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])",
      ) ?? null,
  });

  useEffect(() => {
    return () => {
      if (dockingTimerRef.current !== null) {
        window.clearTimeout(dockingTimerRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    const wasCompactViewport = previousCompactViewportRef.current;
    previousCompactViewportRef.current = isCompactViewport;

    if (!isOpen || isCompactViewport) {
      if (dockingTimerRef.current !== null) {
        window.clearTimeout(dockingTimerRef.current);
        dockingTimerRef.current = null;
      }
      setIsDockingFromCompact(false);
      return;
    }

    if (!wasCompactViewport) {
      return;
    }

    if (reflowDuration === 0) {
      setIsDockingFromCompact(false);
      return;
    }

    setIsDockingFromCompact(true);
    if (dockingTimerRef.current !== null) {
      window.clearTimeout(dockingTimerRef.current);
    }
    dockingTimerRef.current = window.setTimeout(() => {
      dockingTimerRef.current = null;
      setIsDockingFromCompact(false);
    }, reflowDuration);
  }, [isCompactViewport, isOpen, reflowDuration]);

  const frameMode = isCompactViewport
    ? "compact"
    : isDockingFromCompact
      ? "docking"
      : "docked";

  useEffect(() => {
    if (!isOpen || !onRequestClose || !isCompactViewport) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        panelRef.current &&
        panelRef.current.contains(target)
      ) {
        return;
      }
      if (
        target instanceof Element &&
        target.closest(
          "[data-context-panel-toggle], [data-radix-popper-content-wrapper], [data-radix-select-content], [data-radix-dropdown-menu-content]",
        )
      ) {
        return;
      }

      onRequestClose();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [isCompactViewport, isOpen, onRequestClose]);

  return (
    <div
      className={cn(
        allowVerticalShrink ? "min-h-0 shrink overflow-hidden" : "shrink-0",
        frameMode === "docking" && "relative",
        frameMode === "docked" ? "overflow-hidden" : "overflow-visible",
      )}
      style={
        {
          width: isOpen && !isCompactViewport ? panelWidth : 0,
          transition: widthTransitionEnabled
            ? `width ${reflowDuration}ms ease`
            : "none",
          "--context-panel-width": `${panelWidth}px`,
        } as CSSProperties
      }
    >
      <AnimatePresence initial={false}>
        {isOpen ? (
          <motion.div
            ref={handlePanelRef}
            key="context-panel"
            className={cn(
              allowVerticalShrink
                ? "flex min-h-0 max-h-full self-start overflow-hidden"
                : "flex self-start",
              frameMode === "compact" &&
                "absolute right-3 top-[var(--spacing-app-panel-gutter-top)] z-10 max-h-[calc(100%-var(--spacing-app-panel-gutter-top)-var(--spacing-app-panel-gutter-bottom))] w-[min(var(--context-panel-width),calc(100%-1.5rem))]",
              frameMode === "docking" && "absolute right-0 top-0 max-h-full",
              frameMode === "docked" && "max-h-full",
            )}
            style={
              frameMode === "compact"
                ? ({
                    "--context-panel-width": `${panelWidth}px`,
                  } as CSSProperties)
                : { width: panelWidth }
            }
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={fadeTransition}
          >
            <aside
              className={cn(
                "chat-context-panel-surface flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-md bg-background text-foreground",
                "[backdrop-filter:var(--backdrop-chat-context-panel)] [-webkit-backdrop-filter:var(--backdrop-chat-context-panel)]",
                "h-auto max-h-full overflow-y-auto",
                isCompactViewport && "shadow-popover",
              )}
            >
              <ContextPanel
                sessionId={activeSessionId}
                projectId={project?.id}
                projectName={project?.name}
                projectIcon={project?.icon}
                projectColor={project?.color}
                projectWorkingDirs={project?.workingDirs ?? []}
                sessionWorkingDir={sessionWorkingDir}
                terminalOpen={terminalOpen}
                onToggleTerminal={onToggleTerminal}
              />
            </aside>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
