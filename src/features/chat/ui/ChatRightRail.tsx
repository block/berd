import { useCallback, type CSSProperties } from "react";
import { AgentBuilderRail } from "@/features/agents/ui/AgentBuilderRail";
import {
  recoverPendingDraftAgent,
  setAgentBuilderSessionLocalEdits,
} from "@/features/agents/lib/agentBuilderSession";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { listPersonas, type AgentSourceEntry } from "@/shared/api/agents";
import { cn } from "@/shared/lib/cn";
import {
  useChatSessionStore,
  type ChatSession,
} from "../stores/chatSessionStore";
import { ChatContextPanel, CP_TOTAL_W } from "./ChatContextPanel";

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
  onRequestCloseContextPanel?: () => void;
  onToggleTerminal?: () => void;
}

export function ChatRightRail({
  session,
  project,
  builderColumnClassName,
  builderColumnStyle,
  sessionWorkingDir,
  onDraftPromoted,
  onAgentBuilderClose,
  terminalOpen = false,
  onRequestCloseContextPanel,
  onToggleTerminal,
}: ChatRightRailProps) {
  const isContextPanelOpen = useChatSessionStore((s) => s.isContextPanelOpen);
  const patchSession = useChatSessionStore((s) => s.patchSession);
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
          console.error("Failed to refresh agents after leaving edit:", error);
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
    <ChatContextPanel
      activeSessionId={session.id}
      isOpen={isContextPanelOpen}
      project={project}
      sessionWorkingDir={sessionWorkingDir}
      terminalOpen={terminalOpen}
      onRequestClose={onRequestCloseContextPanel}
      onToggleTerminal={onToggleTerminal}
    />
  );
}
