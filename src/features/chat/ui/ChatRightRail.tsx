import {
  forwardRef,
  useCallback,
  type CSSProperties,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { AgentBuilderRail } from "@/features/agents/ui/AgentBuilderRail";
import {
  recoverPendingDraftAgent,
  setAgentBuilderSessionLocalEdits,
} from "@/features/agents/lib/agentBuilderSession";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { listPersonas, type AgentSourceEntry } from "@/shared/api/agents";
import { cn } from "@/shared/lib/cn";
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
  CP_TOTAL_W,
  useChatContextPanelCompactViewport,
} from "./ChatContextPanel";

const AGENT_BUILDER_RAIL_W = Math.round(CP_TOTAL_W * 1.5);
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
  contextPanelLeftViewportOcclusionPx?: number;
  onRequestCloseContextPanel?: () => void;
  onToggleTerminal?: () => void;
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
      contextPanelLeftViewportOcclusionPx = 0,
      onRequestCloseContextPanel,
      onToggleTerminal,
    },
    ref,
  ) {
    const { t } = useTranslation("chat");
    const isContextPanelOpen = useChatSessionStore((s) => s.isContextPanelOpen);
    const isContextPanelCompactViewport = useChatContextPanelCompactViewport(
      contextPanelLeftViewportOcclusionPx,
    );
    const patchSession = useChatSessionStore((s) => s.patchSession);
    const railTerminalDocked =
      terminalController?.visible &&
      terminalController.placement.kind === "docked" &&
      terminalController.placement.region === "rightRail";
    const railPreviewActive = terminalDockPreview?.region === "rightRail";
    const railVisible =
      !isContextPanelCompactViewport &&
      (isContextPanelOpen || railTerminalDocked || railPreviewActive);
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
              width: AGENT_BUILDER_RAIL_W,
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
          />
        </div>
      );
    }

    if (!session?.id) {
      return null;
    }

    return (
      <div
        ref={ref}
        className={cn(
          "relative flex h-full min-h-0 shrink-0 flex-col items-stretch",
          isContextPanelCompactViewport
            ? "overflow-visible"
            : "overflow-hidden",
        )}
        style={{
          width: railVisible ? railWidth : 0,
          // Animate the rail's own width so opening/closing the context panel
          // slides the whole rail in/out from the right edge instead of
          // snapping the chat column reflow. Skip the transition while the
          // user is dragging the resize handle so it tracks the pointer.
          transition: isResizingRail
            ? "none"
            : "width 200ms cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        {railVisible ? (
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
          isOpen={isContextPanelOpen}
          project={project}
          sessionWorkingDir={sessionWorkingDir}
          terminalOpen={terminalOpen}
          panelWidth={railWidth}
          allowVerticalShrink={railTerminalDocked || railPreviewActive}
          widthTransitionEnabled={!isResizingRail}
          leftViewportOcclusionPx={contextPanelLeftViewportOcclusionPx}
          onRequestClose={onRequestCloseContextPanel}
          onToggleTerminal={onToggleTerminal}
        />
        {railPreviewActive ? (
          <TerminalDockPreview
            height={terminalDockPreview.size.height}
            surface="rightRail"
          />
        ) : null}
        {railTerminalDocked && terminalController && terminalRootRef ? (
          <div
            ref={terminalRootRef}
            className="mt-[var(--spacing-app-panel-gutter-inline)] flex min-h-0 shrink flex-col"
          >
            <TerminalCapability
              controller={terminalController}
              rootRef={terminalRootRef}
              sessionId={session.id}
              getDockTargetForPointer={getTerminalDockTargetForPointer}
              onDockPreviewChange={onTerminalDockPreviewChange}
            />
          </div>
        ) : null}
      </div>
    );
  },
);
