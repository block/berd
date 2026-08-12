import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useFocusRegion } from "@/app/focus/FocusRegionProvider";
import { cn } from "@/shared/lib/cn";
import { ContextPanel, ContextPanelWorktreeTracker } from "./ContextPanel";

const CP_PANEL_W = 250;
/** Stable fallback so a missing project can't break the memo boundary. */
const EMPTY_WORKING_DIRS: string[] = [];
export const CP_TOTAL_W = CP_PANEL_W;
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
    if (typeof window === "undefined" || !window.matchMedia) return false;
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
  isVisible: boolean;
  project?: {
    id?: string;
    name?: string;
    icon?: string;
    color?: string;
    workingDirs?: string[];
  } | null;
  sessionWorkingDir?: string | null;
  terminalOpen?: boolean;
  allowVerticalShrink?: boolean;
  elevated?: boolean;
  onToggleTerminal?: () => void;
  onOpenTerminalAtPath?: (path: string) => void;
}

/**
 * Context content hosted by ChatRightRail. Rail visibility and placement live
 * in the host.
 *
 * Memoized as a render boundary: the panel stays mounted while hidden so its
 * git/changed-files queries remain active observers (warm reopen, refreshed by
 * query invalidation when a turn settles), but composer draft flushes and
 * streaming updates re-render ChatView every few hundred milliseconds. Without
 * this boundary the entire hidden ContextPanel subtree re-executed on each of
 * those renders (regression introduced when #798 switched hidden from
 * unmounted to `hidden`).
 */
export const ChatContextPanel = memo(function ChatContextPanel({
  activeSessionId,
  isVisible,
  project,
  sessionWorkingDir,
  terminalOpen = false,
  allowVerticalShrink = false,
  elevated = false,
  onToggleTerminal,
  onOpenTerminalAtPath,
}: ChatContextPanelProps) {
  const [panelElement, setPanelElement] = useState<HTMLDivElement | null>(null);
  const handlePanelRef = useCallback((node: HTMLDivElement | null) => {
    setPanelElement(node);
  }, []);

  useFocusRegion({
    id: "context",
    label: "context",
    key: "x",
    enabled: isVisible,
    element: panelElement,
    getInitialFocus: () =>
      panelElement?.querySelector<HTMLElement>(
        "button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])",
      ) ?? null,
  });

  return (
    <>
      <ContextPanelWorktreeTracker
        sessionId={activeSessionId}
        projectWorkingDirs={project?.workingDirs ?? EMPTY_WORKING_DIRS}
        sessionWorkingDir={sessionWorkingDir}
      />
      <div
        ref={handlePanelRef}
        hidden={!isVisible}
        className={cn(
          "isolate flex w-full self-start overflow-hidden rounded-md",
          allowVerticalShrink && "min-h-0 max-h-full shrink",
          elevated && "shadow-popover",
        )}
      >
        <aside
          className={cn(
            "chat-context-panel-surface flex h-auto max-h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-card-glass text-foreground",
            "[backdrop-filter:var(--backdrop-panel)] [-webkit-backdrop-filter:var(--backdrop-panel)]",
          )}
        >
          <ContextPanel
            sessionId={activeSessionId}
            projectName={project?.name}
            projectIcon={project?.icon}
            projectColor={project?.color}
            projectWorkingDirs={project?.workingDirs ?? EMPTY_WORKING_DIRS}
            sessionWorkingDir={sessionWorkingDir}
            terminalOpen={terminalOpen}
            onToggleTerminal={onToggleTerminal}
            onOpenTerminalAtPath={onOpenTerminalAtPath}
          />
        </aside>
      </div>
    </>
  );
});
