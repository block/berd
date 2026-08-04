import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import {
  AgentBuilderCapability,
  AGENT_BUILDER_RAIL_DESIGN_WIDTH,
} from "@/features/agents/capabilities/AgentBuilderCapability";
import { cn } from "@/shared/lib/cn";
import { hasOpenKeyboardOwningLayer } from "@/app/focus/FocusRegionProvider";
import { TerminalCapability } from "@/features/terminal/capabilities/TerminalCapability";
import { TerminalDockPreview } from "@/features/terminal/ui/TerminalDockPreview";
import type { TerminalController } from "@/features/terminal/hooks/useTerminalController";
import type { TerminalDockedPlacement } from "@/features/terminal/model/terminalState";
import { useGitStateAutoRefreshOnChatSettled } from "../hooks/useGitStateAutoRefresh";
import { useResizableRightRail } from "../hooks/useResizableRightRail";
import type { ChatSession } from "../stores/chatSessionStore";
import {
  ChatContextPanel,
  useChatContextPanelCompactViewport,
} from "./ChatContextPanel";

const RIGHT_RAIL_REFLOW_MS = 200;
interface ChatRightRailProps {
  session: ChatSession | null | undefined;
  project?: {
    id?: string;
    name?: string;
    icon?: string;
    color?: string;
    workingDirs?: string[];
  } | null;
  builderColumnClassName?: string;
  builderColumnStyle?: CSSProperties;
  sessionWorkingDir?: string | null;
  contextVisible: boolean;
  agentBuilderReadOnly?: boolean;
  terminalOpen?: boolean;
  terminalController?: TerminalController;
  terminalDockPreview?: TerminalDockedPlacement | null;
  terminalRootRef?: RefObject<HTMLDivElement | null>;
  getTerminalDockTargetForPointer?: (
    clientX: number,
    clientY: number,
  ) => TerminalDockedPlacement | null;
  onTerminalDockPreviewChange?: (
    placement: TerminalDockedPlacement | null,
  ) => void;
  onTerminalDockToRegion?: (region: TerminalDockedPlacement["region"]) => void;
  contextPanelLeftViewportOcclusionPx?: number;
  onRequestCloseRightRail?: () => void;
  onToggleTerminal?: () => void;
  onOpenTerminalAtPath?: (path: string) => void;
}

export const ChatRightRail = forwardRef<HTMLDivElement, ChatRightRailProps>(
  function ChatRightRail(
    {
      session,
      project,
      builderColumnClassName,
      builderColumnStyle,
      sessionWorkingDir,
      contextVisible,
      agentBuilderReadOnly = false,
      terminalOpen = false,
      terminalController,
      terminalDockPreview,
      terminalRootRef,
      getTerminalDockTargetForPointer,
      onTerminalDockPreviewChange,
      onTerminalDockToRegion,
      contextPanelLeftViewportOcclusionPx = 0,
      onRequestCloseRightRail,
      onToggleTerminal,
      onOpenTerminalAtPath,
    },
    ref,
  ) {
    const { t } = useTranslation("chat");
    const shouldReduceMotion = useReducedMotion();
    const reflowDuration = shouldReduceMotion ? 0 : RIGHT_RAIL_REFLOW_MS;
    const internalRailRef = useRef<HTMLDivElement | null>(null);
    const setRailRef = useCallback(
      (node: HTMLDivElement | null) => {
        internalRailRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );
    const isContextPanelCompactViewport = useChatContextPanelCompactViewport(
      contextPanelLeftViewportOcclusionPx,
    );
    const previousCompactViewportRef = useRef(isContextPanelCompactViewport);
    const dockingTimerRef = useRef<number | null>(null);
    const [isDockingFromOverlay, setIsDockingFromOverlay] = useState(false);
    const agentBuilderVisible =
      !agentBuilderReadOnly &&
      session?.intent === "build-agent" &&
      session.agentBuilderOpen !== false;
    const railTerminalDocked =
      terminalController?.visible &&
      terminalController.placement.kind === "docked" &&
      terminalController.placement.region === "rightRail";
    const railPreviewActive = terminalDockPreview?.region === "rightRail";
    const railHostVisible =
      contextVisible || railTerminalDocked || railPreviewActive;

    useEffect(() => {
      return () => {
        if (dockingTimerRef.current !== null) {
          window.clearTimeout(dockingTimerRef.current);
        }
      };
    }, []);

    useLayoutEffect(() => {
      const wasCompactViewport = previousCompactViewportRef.current;
      previousCompactViewportRef.current = isContextPanelCompactViewport;

      if (!railHostVisible || isContextPanelCompactViewport) {
        if (dockingTimerRef.current !== null) {
          window.clearTimeout(dockingTimerRef.current);
          dockingTimerRef.current = null;
        }
        setIsDockingFromOverlay(false);
        return;
      }

      if (!wasCompactViewport || reflowDuration === 0) return;

      setIsDockingFromOverlay(true);
      dockingTimerRef.current = window.setTimeout(() => {
        dockingTimerRef.current = null;
        setIsDockingFromOverlay(false);
      }, reflowDuration);
    }, [isContextPanelCompactViewport, railHostVisible, reflowDuration]);

    useEffect(() => {
      if (
        !contextVisible ||
        !isContextPanelCompactViewport ||
        !onRequestCloseRightRail
      ) {
        return;
      }

      const handleKeyDown = (event: KeyboardEvent) => {
        if (
          event.key !== "Escape" ||
          event.defaultPrevented ||
          hasOpenKeyboardOwningLayer()
        ) {
          return;
        }
        event.preventDefault();
        onRequestCloseRightRail();
      };
      const handlePointerDown = (event: PointerEvent) => {
        const target = event.target;
        if (
          target instanceof Node &&
          internalRailRef.current?.contains(target)
        ) {
          return;
        }
        if (
          target instanceof Element &&
          target.closest(
            "[data-right-rail-toggle], [data-radix-popper-content-wrapper], [data-radix-select-content], [data-radix-dropdown-menu-content]",
          )
        ) {
          return;
        }
        onRequestCloseRightRail();
      };

      document.addEventListener("keydown", handleKeyDown);
      document.addEventListener("pointerdown", handlePointerDown, true);
      return () => {
        document.removeEventListener("keydown", handleKeyDown);
        document.removeEventListener("pointerdown", handlePointerDown, true);
      };
    }, [
      isContextPanelCompactViewport,
      onRequestCloseRightRail,
      contextVisible,
    ]);
    const { railWidth, isResizingRail, startRailResize } =
      useResizableRightRail();

    useGitStateAutoRefreshOnChatSettled({
      sessionId: session?.id,
      sessionWorkingDir,
      projectWorkingDirs: project?.workingDirs,
    });
    if (!session?.id) {
      return null;
    }

    const railPresentationVisible =
      (contextVisible || railTerminalDocked) && !isContextPanelCompactViewport;
    const previewingClosedRail = railPreviewActive && !contextVisible;
    const railSurfaceFloating =
      railHostVisible &&
      (isContextPanelCompactViewport ||
        isDockingFromOverlay ||
        previewingClosedRail);

    const agentBuilderWidth = `min(${AGENT_BUILDER_RAIL_DESIGN_WIDTH}px, calc((100vw - ${contextPanelLeftViewportOcclusionPx}px) / 2))`;
    const contextRailWidth = railPresentationVisible ? railWidth : 0;

    return (
      <div
        ref={setRailRef}
        data-chat-right-rail
        aria-hidden={
          !agentBuilderVisible && !railHostVisible ? true : undefined
        }
        inert={!agentBuilderVisible && !railHostVisible ? true : undefined}
        className={cn(
          "relative flex h-full min-h-0 shrink-0 items-stretch",
          agentBuilderVisible && "gap-[var(--spacing-app-panel-gutter-inline)]",
          isContextPanelCompactViewport ||
            isDockingFromOverlay ||
            previewingClosedRail
            ? "overflow-visible"
            : "overflow-hidden",
          !agentBuilderVisible &&
            !railHostVisible &&
            "invisible pointer-events-none",
        )}
        style={{
          width:
            agentBuilderVisible && contextRailWidth > 0
              ? `calc(${agentBuilderWidth} + ${contextRailWidth}px + var(--spacing-app-panel-gutter-inline))`
              : agentBuilderVisible
                ? agentBuilderWidth
                : contextRailWidth,
          transition:
            isResizingRail || reflowDuration === 0
              ? "none"
              : `width ${reflowDuration}ms cubic-bezier(0.22, 1, 0.36, 1)`,
        }}
      >
        {agentBuilderVisible ? (
          <div
            className={cn(
              "flex h-full shrink-0 justify-center overflow-hidden",
              builderColumnClassName,
            )}
            style={
              {
                width: agentBuilderWidth,
                ...builderColumnStyle,
              } as CSSProperties
            }
          >
            <AgentBuilderCapability session={session} />
          </div>
        ) : null}
        <div
          data-right-rail-surface
          className={cn(
            "flex min-h-0 shrink-0 flex-col items-stretch",
            !railHostVisible && "invisible pointer-events-none",
            railSurfaceFloating &&
              "absolute z-40 max-h-[calc(100%-var(--spacing-app-panel-gutter-top)-var(--spacing-app-panel-gutter-bottom))]",
            isContextPanelCompactViewport &&
              "right-3 top-[var(--spacing-app-panel-gutter-top)]",
            (isDockingFromOverlay || previewingClosedRail) && "right-0 top-0",
          )}
          style={
            railSurfaceFloating
              ? { width: `min(${railWidth}px, calc(100vw - 1.5rem))` }
              : { width: contextRailWidth }
          }
        >
          {railPresentationVisible ? (
            <button
              type="button"
              tabIndex={-1}
              aria-label={t("rightRail.resize")}
              title={t("rightRail.resize")}
              data-right-rail-resize-edge="left"
              onPointerDown={startRailResize}
              className="absolute top-2 bottom-2 left-0 z-30 w-3 -translate-x-1/2 cursor-col-resize bg-transparent outline-none"
            />
          ) : null}
          <ChatContextPanel
            activeSessionId={session.id}
            isVisible={contextVisible || railPreviewActive}
            project={project}
            sessionWorkingDir={sessionWorkingDir}
            terminalOpen={terminalOpen}
            allowVerticalShrink={railTerminalDocked || railPreviewActive}
            elevated={isContextPanelCompactViewport}
            onToggleTerminal={onToggleTerminal}
            onOpenTerminalAtPath={onOpenTerminalAtPath}
          />
          {railPreviewActive && railHostVisible ? (
            <TerminalDockPreview
              height={terminalDockPreview.size.height}
              surface="rightRail"
            />
          ) : null}
          {railTerminalDocked && terminalController && terminalRootRef ? (
            <div
              ref={terminalRootRef}
              className={cn(
                "mt-[var(--spacing-app-panel-gutter-inline)] flex min-h-0 shrink flex-col overflow-hidden rounded-md",
                isContextPanelCompactViewport && "shadow-popover",
              )}
            >
              <TerminalCapability
                controller={terminalController}
                rootRef={terminalRootRef}
                sessionId={session.id}
                getDockTargetForPointer={getTerminalDockTargetForPointer}
                onDockPreviewChange={onTerminalDockPreviewChange}
                onDockToRegion={onTerminalDockToRegion}
              />
            </div>
          ) : null}
        </div>
      </div>
    );
  },
);
