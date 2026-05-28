import { useCallback, type CSSProperties } from "react";
import { AgentBuilderRail } from "@/features/agents/ui/AgentBuilderRail";
import { recoverDraftAgent } from "@/features/agents/lib/agentBuilderSession";
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
    name?: string;
    color?: string;
    workingDirs?: string[];
  } | null;
  builderColumnClassName?: string;
  builderColumnStyle?: CSSProperties;
  sessionWorkingDir?: string | null;
  onDraftPromoted?: (source: AgentSourceEntry) => void;
}

export function ChatRightRail({
  session,
  project,
  builderColumnClassName,
  builderColumnStyle,
  sessionWorkingDir,
  onDraftPromoted,
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
      });
    },
    [patchSession, session?.id],
  );
  const handleRecoverMissingDraft = useCallback(async () => {
    if (!session?.id) {
      return;
    }

    const target = await recoverDraftAgent(session.id, session.targetAgentPath);
    patchSession(session.id, {
      intent: "build-agent",
      targetAgentPath: target.path,
      targetAgentSlug: target.slug,
    });
  }, [patchSession, session?.id, session?.targetAgentPath]);

  if (
    session?.intent === "build-agent" &&
    session.targetAgentPath &&
    session.targetAgentSlug
  ) {
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
          targetAgentPath={session.targetAgentPath}
          targetAgentSlug={session.targetAgentSlug}
          onDraftPromoted={handleDraftPromoted}
          onDraftTargetChanged={handleDraftTargetChanged}
          onRecoverMissingDraft={handleRecoverMissingDraft}
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
    />
  );
}
