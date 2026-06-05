import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useCallback,
  useEffect,
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
export const CHAT_CONTEXT_PANEL_COMPACT_QUERY = "(max-width: 900px)";

export function useChatContextPanelCompactViewport() {
  const [isCompactViewport, setIsCompactViewport] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return false;
    }
    return window.matchMedia(CHAT_CONTEXT_PANEL_COMPACT_QUERY).matches;
  });

  useEffect(() => {
    if (!window.matchMedia) return;

    const mediaQuery = window.matchMedia(CHAT_CONTEXT_PANEL_COMPACT_QUERY);
    setIsCompactViewport(mediaQuery.matches);

    const handleChange = (event: MediaQueryListEvent) => {
      setIsCompactViewport(event.matches);
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  return isCompactViewport;
}

interface ChatContextPanelProps {
  activeSessionId: string;
  isOpen: boolean;
  project?: {
    name?: string;
    color?: string;
    workingDirs?: string[];
  } | null;
  sessionWorkingDir?: string | null;
  terminalOpen?: boolean;
  onRequestClose?: () => void;
  onToggleTerminal?: () => void;
}

export function ChatContextPanel({
  activeSessionId,
  isOpen,
  project,
  sessionWorkingDir,
  terminalOpen = false,
  onRequestClose,
  onToggleTerminal,
}: ChatContextPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelElement, setPanelElement] = useState<HTMLDivElement | null>(null);
  const shouldReduceMotion = useReducedMotion();
  const isCompactViewport = useChatContextPanelCompactViewport();
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
          "[data-radix-popper-content-wrapper], [data-radix-select-content], [data-radix-dropdown-menu-content]",
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
        "shrink-0",
        isCompactViewport ? "overflow-visible" : "overflow-hidden",
      )}
      style={{
        width: isOpen && !isCompactViewport ? CP_TOTAL_W : 0,
        transition: `width ${reflowDuration}ms ease`,
      }}
    >
      <AnimatePresence initial={false}>
        {isOpen ? (
          <motion.div
            ref={handlePanelRef}
            key="context-panel"
            className={cn(
              "flex self-start",
              isCompactViewport
                ? "absolute right-3 top-[var(--spacing-app-panel-gutter-top)] z-10 max-h-[calc(100%-var(--spacing-app-panel-gutter-top)-var(--spacing-app-panel-gutter-bottom))] w-[min(var(--context-panel-width),calc(100%-1.5rem))]"
                : "max-h-full",
            )}
            style={
              isCompactViewport
                ? ({
                    "--context-panel-width": `${CP_PANEL_W}px`,
                  } as CSSProperties)
                : { width: CP_TOTAL_W }
            }
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={fadeTransition}
          >
            <aside
              className={cn(
                "chat-context-panel-surface flex min-w-0 flex-1 overflow-hidden rounded-md bg-background text-foreground backdrop-blur-md",
                "h-auto max-h-full overflow-y-auto",
                isCompactViewport && "shadow-popover",
              )}
            >
              <ContextPanel
                sessionId={activeSessionId}
                projectName={project?.name}
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
