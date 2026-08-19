import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  clearBuilderSessionState,
  recoverPendingDraftAgent,
  saveDraftAgentSession,
  setAgentBuilderSessionLocalEdits,
  setAgentBuilderSessionSaveHandler,
} from "@/features/agents/lib/agentBuilderSession";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import {
  AgentBuilderRail,
  AGENT_BUILDER_RAIL_WIDTH as AGENT_BUILDER_RAIL_INTERNAL_WIDTH,
} from "@/features/agents/ui/AgentBuilderRail";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  agentSourceToPersona,
  listPersonas,
  type AgentSourceEntry,
} from "@/shared/api/agents";

/** Design width hosts should use when laying out the chat-rail render mode. */
export const AGENT_BUILDER_RAIL_DESIGN_WIDTH =
  AGENT_BUILDER_RAIL_INTERNAL_WIDTH;

export interface AgentBuilderCapabilityProps {
  session: ChatSession;
  className?: string;
  /**
   * When the host collapses the chat column so the builder takes the full
   * surface. Layout state is owned by the host (ChatView); the capability
   * just forwards it to the rail's full-page render mode.
   */
  fullPage?: boolean;
  /** Reopens the collapsed chat column while in full-page mode. */
  onExpandChat?: () => void;
  onDraftPromoted?: (source: AgentSourceEntry) => void;
  onAgentBuilderCompleted?: (agentId: string) => void;
}

export function AgentBuilderCapability({
  session,
  className,
  fullPage = false,
  onExpandChat,
  onDraftPromoted,
  onAgentBuilderCompleted,
}: AgentBuilderCapabilityProps) {
  const { t } = useTranslation("agents");
  const patchSession = useChatSessionStore((state) => state.patchSession);

  const refreshPersonas = useCallback(async () => {
    const personas = await listPersonas();
    useAgentStore.getState().setPersonas(personas);
  }, []);

  const completeBuilder = useCallback(
    (source: AgentSourceEntry, refreshErrorMessage: string) => {
      clearBuilderSessionState(session.id);

      // Promotion is the durable source of truth. Seed the store immediately
      // so the destination profile exists even if the follow-up disk refresh
      // fails or has not observed the promoted source yet.
      const promotedPersona = agentSourceToPersona(source);
      const agentStore = useAgentStore.getState();
      const existingPersona = agentStore.personas.find(
        (persona) => persona.id === promotedPersona.id,
      );
      if (existingPersona) {
        agentStore.updatePersona(promotedPersona.id, promotedPersona);
      } else {
        agentStore.addPersona(promotedPersona);
      }

      onDraftPromoted?.(source);
      onAgentBuilderCompleted?.(promotedPersona.id);

      void refreshPersonas().catch((error) => {
        console.error(refreshErrorMessage, error);
      });
    },
    [onAgentBuilderCompleted, onDraftPromoted, refreshPersonas, session.id],
  );

  const handleDraftPromoted = useCallback(
    (source: AgentSourceEntry) => {
      completeBuilder(source, "Failed to refresh agents after save:");
    },
    [completeBuilder],
  );

  const handleDraftTargetChanged = useCallback(
    (target: { path: string; slug: string }) => {
      patchSession(session.id, {
        targetAgentPath: target.path,
        targetAgentSlug: target.slug,
        targetAgentDraftState: null,
      });
    },
    [patchSession, session.id],
  );

  const handleRecoverMissingDraft = useCallback(async () => {
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
        agentBuilderOpen: true,
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
  }, [patchSession, session.id, session.targetAgentPath]);

  const handleLocalEditStateChange = useCallback(
    (hasLocalEdits: boolean) => {
      setAgentBuilderSessionLocalEdits(session.id, hasLocalEdits);
    },
    [session.id],
  );

  const handleSaveDraftHandlerChange = useCallback(
    (saveDraft: (() => boolean | Promise<boolean>) | null) => {
      setAgentBuilderSessionSaveHandler(session.id, saveDraft);
    },
    [session.id],
  );

  const handleClose = useCallback(async () => {
    try {
      await saveDraftAgentSession(session.id);
    } catch (error) {
      console.error("Failed to save agent draft before closing:", error);
      toast.error(t("builderRail.saveError"));
      return;
    }

    const closePatch: Partial<ChatSession> = {
      agentBuilderOpen: false,
      agentBuilderContextState: undefined,
    };
    patchSession(session.id, closePatch);
  }, [patchSession, session.id, t]);

  useEffect(() => {
    if (session.intent !== "build-agent") {
      return;
    }

    return () => {
      setAgentBuilderSessionSaveHandler(session.id, null);
    };
  }, [session.id, session.intent]);

  const draftState =
    session.targetAgentDraftState ??
    (session.targetAgentPath ? null : "preparing");

  return (
    <AgentBuilderRail
      className={className}
      sessionId={session.id}
      targetAgentPath={session.targetAgentPath ?? null}
      targetAgentSlug={session.targetAgentSlug ?? null}
      draftState={draftState}
      fullPage={fullPage}
      onExpandChat={fullPage ? onExpandChat : undefined}
      onDraftPromoted={handleDraftPromoted}
      onDraftTargetChanged={handleDraftTargetChanged}
      onRecoverMissingDraft={handleRecoverMissingDraft}
      onClose={handleClose}
      onLocalEditStateChange={handleLocalEditStateChange}
      onSaveDraftHandlerChange={handleSaveDraftHandlerChange}
    />
  );
}
