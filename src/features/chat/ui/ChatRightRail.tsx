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
  AgentBuilderRail,
  AGENT_BUILDER_RAIL_WIDTH,
} from "@/features/agents/ui/AgentBuilderRail";
import {
  recoverPendingDraftAgent,
  setAgentBuilderSessionLocalEdits,
  setAgentBuilderSessionSaveHandler,
} from "@/features/agents/lib/agentBuilderSession";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { listPersonas, type AgentSourceEntry } from "@/shared/api/agents";
import { cn } from "@/shared/lib/cn";
import { hasOpenKeyboardOwningLayer } from "@/app/focus/FocusRegionProvider";
import { TerminalCapability } from "@/features/terminal/capabilities/TerminalCapability";
import { TerminalDockPreview } from "@/features/terminal/ui/TerminalDockPreview";
import type { TerminalController } from "@/features/terminal/hooks/useTerminalController";
import type { TerminalDockedPlacement } from "@/features/terminal/model/terminalState";
import { useGitStateAutoRefreshOnChatSettled } from "../hooks/useGitStateAutoRefresh";
import { useResizableRightRail } from "../hooks/useResizableRightRail";
import {
  useChatSessionStore,
  type ChatSession,
} from "../stores/chatSessionStore";
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
  onDraftPromoted?: (source: AgentSourceEntry) => void;
  onAgentBuilderClose?: () => void;
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
      onDraftPromoted,
      onAgentBuilderClose,
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
    const isRightRailOpen = useChatSessionStore((s) => s.isRightRailOpen);
    const isContextPanelCompactViewport = useChatContextPanelCompactViewport(
      contextPanelLeftViewportOcclusionPx,
    );
    const previousCompactViewportRef = useRef(isContextPanelCompactViewport);
    const dockingTimerRef = useRef<number | null>(null);
    const [isDockingFromOverlay, setIsDockingFromOverlay] = useState(false);
    const patchSession = useChatSessionStore((s) => s.patchSession);
    const railTerminalDocked =
      terminalController?.visible &&
      terminalController.placement.kind === "docked" &&
      terminalController.placement.region === "rightRail";
    const railPreviewActive = terminalDockPreview?.region === "rightRail";
    const railHostVisible = isRightRailOpen || railPreviewActive;

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
        !railHostVisible ||
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
      railHostVisible,
    ]);
    const { railWidth, isResizingRail, startRailResize } =
      useResizableRightRail();

    useGitStateAutoRefreshOnChatSettled({
      sessionId: session?.id,
      sessionWorkingDir,
      projectWorkingDirs: project?.workingDirs,
    });
    const handleDraftPromoted = useCallback(
      (source: AgentSourceEntry) => {
        if (!session?.id) {
          return;
        }

        patchSession(session.id, {
          intent: null,
          targetAgentPath: null,
          targetAgentSlug: null,
          targetAgentDraftState: null,
        });
        void listPersonas()
          .then((personas) => {
            useAgentStore.getState().setPersonas(personas);
          })
          .catch((error) => {
            console.error("Failed to refresh agents after save:", error);
          })
          .finally(() => {
            onDraftPromoted?.(source);
          });
      },
      [onDraftPromoted, patchSession, session?.id],
    );
    const handleDraftTargetChanged = useCallback(
      (target: { path: string; slug: string }) => {
        if (!session?.id) {
          return;
        }

        patchSession(session.id, {
          targetAgentPath: target.path,
          targetAgentSlug: target.slug,
          targetAgentDraftState: null,
        });
      },
      [patchSession, session?.id],
    );
    const handleBuilderBack = useCallback(
      (source: AgentSourceEntry) => {
        if (!session?.id) {
          return;
        }

        patchSession(session.id, {
          intent: null,
          targetAgentPath: null,
          targetAgentSlug: null,
          targetAgentDraftState: null,
        });
        void listPersonas()
          .then((personas) => {
            useAgentStore.getState().setPersonas(personas);
          })
          .catch((error) => {
            console.error(
              "Failed to refresh agents after leaving edit:",
              error,
            );
          })
          .finally(() => {
            onDraftPromoted?.(source);
          });
      },
      [onDraftPromoted, patchSession, session?.id],
    );
    const handleRecoverMissingDraft = useCallback(async () => {
      if (!session?.id) {
        return;
      }

      patchSession(session.id, {
        targetAgentDraftState: "preparing",
      });

      try {
        const target = await recoverPendingDraftAgent(
          session.id,
          session.targetAgentPath,
        );
        patchSession(session.id, {
          intent: "build-agent",
          targetAgentPath: target.path,
          targetAgentSlug: target.slug,
          targetAgentDraftState: null,
        });
      } catch (error) {
        patchSession(session.id, {
          targetAgentDraftState: "failed",
        });
        throw error;
      }
    }, [patchSession, session?.id, session?.targetAgentPath]);
    const handleLocalEditStateChange = useCallback(
      (hasLocalEdits: boolean) => {
        if (!session?.id) {
          return;
        }

        setAgentBuilderSessionLocalEdits(session.id, hasLocalEdits);
      },
      [session?.id],
    );
    const handleSaveDraft = useCallback(
      (saveDraft: (() => boolean | Promise<boolean>) | null) => {
        if (!session?.id) {
          return;
        }

        setAgentBuilderSessionSaveHandler(session.id, saveDraft);
      },
      [session?.id],
    );

    useEffect(() => {
      if (session?.intent !== "build-agent" || !session.id) {
        return;
      }

      return () => {
        setAgentBuilderSessionSaveHandler(session.id, null);
      };
    }, [session?.id, session?.intent]);

    if (session?.intent === "build-agent") {
      const draftState =
        session.targetAgentDraftState ??
        (session.targetAgentPath ? null : "preparing");
      return (
        <div
          className={cn(
            "flex h-full shrink-0 justify-center overflow-hidden",
            builderColumnClassName,
          )}
          style={
            {
              // Cap the column at half the main content width (viewport minus
              // the docked sidebar occlusion) so narrow windows keep a usable
              // chat column; on wide layouts this resolves to the rail's full
              // design width, mirroring the old lg: breakpoint behavior.
              width: `min(${AGENT_BUILDER_RAIL_WIDTH}px, calc((100vw - ${contextPanelLeftViewportOcclusionPx}px) / 2))`,
              ...builderColumnStyle,
            } as CSSProperties
          }
        >
          <AgentBuilderRail
            sessionId={session.id}
            targetAgentPath={session.targetAgentPath ?? null}
            targetAgentSlug={session.targetAgentSlug ?? null}
            draftState={draftState}
            onDraftPromoted={handleDraftPromoted}
            onDraftTargetChanged={handleDraftTargetChanged}
            onRecoverMissingDraft={handleRecoverMissingDraft}
            onBack={handleBuilderBack}
            onClose={onAgentBuilderClose}
            onLocalEditStateChange={handleLocalEditStateChange}
            onSaveDraftHandlerChange={handleSaveDraft}
          />
        </div>
      );
    }

    if (!session?.id) {
      return null;
    }

    const railPresentationVisible =
      isRightRailOpen && !isContextPanelCompactViewport;
    const previewingClosedRail = railPreviewActive && !isRightRailOpen;
    const railSurfaceFloating =
      railHostVisible &&
      (isContextPanelCompactViewport ||
        isDockingFromOverlay ||
        previewingClosedRail);

    return (
      <div
        ref={setRailRef}
        data-chat-right-rail
        aria-hidden={!railHostVisible || undefined}
        inert={!railHostVisible ? true : undefined}
        className={cn(
          "relative flex h-full min-h-0 shrink-0 flex-col items-stretch",
          isContextPanelCompactViewport ||
            isDockingFromOverlay ||
            previewingClosedRail
            ? "overflow-visible"
            : "overflow-hidden",
          !railHostVisible && "invisible pointer-events-none",
        )}
        style={{
          width: railPresentationVisible ? railWidth : 0,
          transition:
            isResizingRail || reflowDuration === 0
              ? "none"
              : `width ${reflowDuration}ms cubic-bezier(0.22, 1, 0.36, 1)`,
        }}
      >
        <div
          data-right-rail-surface
          className={cn(
            "flex min-h-0 w-full flex-col items-stretch",
            railSurfaceFloating &&
              "absolute z-40 max-h-[calc(100%-var(--spacing-app-panel-gutter-top)-var(--spacing-app-panel-gutter-bottom))]",
            isContextPanelCompactViewport &&
              "right-3 top-[var(--spacing-app-panel-gutter-top)]",
            (isDockingFromOverlay || previewingClosedRail) && "right-0 top-0",
          )}
          style={
            railSurfaceFloating
              ? { width: `min(${railWidth}px, calc(100vw - 1.5rem))` }
              : undefined
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
            isVisible={railHostVisible}
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
