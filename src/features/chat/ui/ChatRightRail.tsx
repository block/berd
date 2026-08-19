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
import { AgentBuilderCapability } from "@/features/agents/capabilities/AgentBuilderCapability";
import type { AgentBuilderRailSeparatorProps } from "@/features/chat/hooks/useResizableAgentBuilderRail";
import { cn } from "@/shared/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
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
  /**
   * When editing an agent, whether the chat column is collapsed so the builder
   * takes the full surface. Owned by ChatView as per-session view state.
   */
  agentBuilderChatCollapsed?: boolean;
  /**
   * Accessibility + interaction props for the builder rail's left-edge resize
   * divider (pointer drag and keyboard nudge). Owned by ChatView, which drives
   * the two-column grid width.
   */
  builderRailSeparatorProps?: AgentBuilderRailSeparatorProps;
  /**
   * Reopens the collapsed chat column. Surfaced as an expand control in the
   * builder header while the chat is hidden.
   */
  onExpandAgentBuilderChat?: () => void;
  onAgentBuilderCompleted?: (agentId: string) => void;
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
      agentBuilderChatCollapsed = false,
      builderRailSeparatorProps,
      onExpandAgentBuilderChat,
      onAgentBuilderCompleted,
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
    const { t } = useTranslation(["chat", "agents"]);
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
          "relative flex h-full min-h-0 items-stretch",
          // Builder sessions live in ChatView's two-column grid, so the cell
          // fills its track; context-only rails keep their fixed width.
          agentBuilderVisible ? "min-w-0 flex-1" : "shrink-0",
          agentBuilderVisible &&
            contextRailWidth > 0 &&
            "gap-[var(--spacing-app-panel-gutter-inline)]",
          isContextPanelCompactViewport ||
            isDockingFromOverlay ||
            previewingClosedRail
            ? "overflow-visible"
            : "overflow-hidden",
          !agentBuilderVisible &&
            !railHostVisible &&
            "invisible pointer-events-none",
        )}
        style={
          agentBuilderVisible
            ? undefined
            : {
                width: contextRailWidth,
                transition:
                  isResizingRail || reflowDuration === 0
                    ? "none"
                    : `width ${reflowDuration}ms cubic-bezier(0.22, 1, 0.36, 1)`,
              }
        }
      >
        {agentBuilderVisible ? (
          // ChatView owns the two-column grid (width, collapse, resize). This
          // cell just fills its track and hosts the left-edge resize divider.
          // Builder session lifecycle (save/close/draft handlers) lives in
          // AgentBuilderCapability, not here.
          <div
            className={cn(
              "relative flex h-full min-w-0 flex-1 justify-center overflow-hidden",
              builderColumnClassName,
            )}
            style={builderColumnStyle}
          >
            {builderRailSeparatorProps && !agentBuilderChatCollapsed ? (
              // Keyboard users adjust the split with arrow/Home/End keys, so
              // this is a focusable separator rather than a pointer-only hit
              // area. Attributes are listed explicitly rather than spread so
              // the static a11y lint can see the separator role together with
              // the aria-value* props it requires.
              // biome-ignore lint/a11y/useSemanticElements: <hr> is a thematic break, not a focusable drag splitter, and its height:0 reset would collapse this hit area
              <div
                role="separator"
                tabIndex={builderRailSeparatorProps.tabIndex}
                aria-orientation={builderRailSeparatorProps["aria-orientation"]}
                aria-valuenow={builderRailSeparatorProps["aria-valuenow"]}
                aria-valuemin={builderRailSeparatorProps["aria-valuemin"]}
                aria-valuemax={builderRailSeparatorProps["aria-valuemax"]}
                onPointerDown={builderRailSeparatorProps.onPointerDown}
                onKeyDown={builderRailSeparatorProps.onKeyDown}
                aria-label={t("agents:builderRail.resizeRail")}
                title={t("agents:builderRail.resizeRail")}
                data-agent-builder-rail-resize-edge="left"
                className="absolute top-2 bottom-2 left-0 z-30 w-3 -translate-x-1/2 cursor-col-resize bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            ) : null}
            <AgentBuilderCapability
              session={session}
              fullPage={agentBuilderChatCollapsed}
              onExpandChat={
                agentBuilderChatCollapsed ? onExpandAgentBuilderChat : undefined
              }
              onAgentBuilderCompleted={onAgentBuilderCompleted}
            />
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
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={t("rightRail.resize")}
                  data-right-rail-resize-edge="left"
                  onPointerDown={startRailResize}
                  className="absolute top-2 bottom-2 left-0 z-30 w-3 -translate-x-1/2 cursor-col-resize bg-transparent outline-none"
                />
              </TooltipTrigger>
              <TooltipContent>{t("rightRail.resize")}</TooltipContent>
            </Tooltip>
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
