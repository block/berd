import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { AgentSourceEntry } from "@/shared/api/agents";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { AgentBuilderLeaveDraftDialogProps } from "../ui/AgentBuilderLeaveDraftDialog";
import {
  discardDraftAgentSession,
  hasAgentBuilderSessionUserContent,
  isDraftAgentBuilderSession,
  reconcileAgentBuilderSessions,
  startAgentBuilderSession,
  type StartAgentBuilderSessionDeps,
} from "../lib/agentBuilderSession";

type MaybePromise<T> = T | Promise<T>;

interface NavigateAgentsOptions {
  replace?: boolean;
}

interface UseAgentBuilderCoordinatorOptions {
  startupReady: boolean;
  createNewTab: StartAgentBuilderSessionDeps["createNewTab"];
  closeSession: (sessionId: string) => MaybePromise<void>;
  navigateChat: (sessionId: string) => MaybePromise<void>;
  navigateAgents: (
    personaId: string | null,
    options?: NavigateAgentsOptions,
  ) => MaybePromise<void>;
}

type PendingNavigation = () => void;

export function useAgentBuilderCoordinator({
  startupReady,
  createNewTab,
  closeSession,
  navigateChat,
  navigateAgents,
}: UseAgentBuilderCoordinatorOptions) {
  const { t } = useTranslation("agents");
  const [leaveDraftPromptOpen, setLeaveDraftPromptOpen] = useState(false);
  const pendingNavigationRef = useRef<PendingNavigation | null>(null);
  const pendingSessionIdRef = useRef<string | null>(null);
  const sessionsSignature = useChatSessionStore((state) =>
    state.sessions
      .map(
        (session) =>
          `${session.id}:${session.archivedAt ?? ""}:${session.intent ?? ""}:${session.targetAgentPath ?? ""}:${session.targetAgentSlug ?? ""}`,
      )
      .join("|"),
  );
  const hasHydratedSessions = useChatSessionStore(
    (state) => state.hasHydratedSessions,
  );
  const hasMoreSessions = useChatSessionStore((state) => state.hasMoreSessions);

  useEffect(() => {
    if (!startupReady) {
      return;
    }

    void hasHydratedSessions;
    void hasMoreSessions;
    void sessionsSignature;

    void reconcileAgentBuilderSessions().catch((error) => {
      console.error("Failed to reconcile agent builder sessions:", error);
    });
  }, [hasHydratedSessions, hasMoreSessions, sessionsSignature, startupReady]);

  const clearPendingNavigation = useCallback(() => {
    pendingNavigationRef.current = null;
    pendingSessionIdRef.current = null;
    setLeaveDraftPromptOpen(false);
  }, []);

  const runPendingNavigation = useCallback(() => {
    const next = pendingNavigationRef.current;
    clearPendingNavigation();
    next?.();
  }, [clearPendingNavigation]);

  const promptForNavigation = useCallback(
    (sessionId: string, next: PendingNavigation) => {
      pendingNavigationRef.current = next;
      pendingSessionIdRef.current = sessionId;
      setLeaveDraftPromptOpen(true);
    },
    [],
  );

  const guardNavigation = useCallback(
    (next: PendingNavigation): boolean => {
      const session = useChatSessionStore.getState().getActiveSession();
      if (!session || session.intent !== "build-agent") {
        next();
        return true;
      }

      void (async () => {
        const hasUserContent = await hasAgentBuilderSessionUserContent(
          session.id,
        );
        if (!hasUserContent) {
          next();
          return;
        }

        promptForNavigation(session.id, next);
      })().catch((error) => {
        console.error("Failed to inspect active agent draft:", error);
        promptForNavigation(session.id, next);
      });

      return false;
    },
    [promptForNavigation],
  );

  const start = useCallback(
    (args?: { path?: string; slug?: string }) => {
      const startBuilderSession = () => {
        clearPendingNavigation();
        void startAgentBuilderSession(args, {
          createNewTab,
          closeSession,
          navigateChat,
        }).catch((error) => {
          console.error("Failed to start agent builder session:", error);
          toast.error(t("builderRail.openFailed"));
        });
      };

      const session = useChatSessionStore.getState().getActiveSession();
      if (session?.intent === "build-agent") {
        void (async () => {
          const isDraft = await isDraftAgentBuilderSession(session.id);
          if (
            isDraft &&
            !(await hasAgentBuilderSessionUserContent(session.id))
          ) {
            await discardDraftAgentSession(session.id, { closeSession }).catch(
              (error) => {
                console.error("Failed to discard empty agent draft:", error);
              },
            );
            startBuilderSession();
            return;
          }

          guardNavigation(startBuilderSession);
        })().catch((error) => {
          console.error("Failed to inspect active agent draft:", error);
          guardNavigation(startBuilderSession);
        });
        return;
      }

      guardNavigation(startBuilderSession);
    },
    [
      clearPendingNavigation,
      closeSession,
      createNewTab,
      guardNavigation,
      navigateChat,
      t,
    ],
  );

  const create = useCallback(() => {
    start();
  }, [start]);

  const onSaved = useCallback(
    (source: AgentSourceEntry) => {
      void navigateAgents(source.path, { replace: true });
    },
    [navigateAgents],
  );

  const handleCancelLeaveDraft = useCallback(() => {
    clearPendingNavigation();
  }, [clearPendingNavigation]);

  const handleDiscardLeaveDraft = useCallback(() => {
    const sessionId = pendingSessionIdRef.current;
    setLeaveDraftPromptOpen(false);
    if (!sessionId) {
      runPendingNavigation();
      return;
    }

    void discardDraftAgentSession(sessionId)
      .catch((error) => {
        console.error("Failed to discard agent draft:", error);
      })
      .finally(() => {
        runPendingNavigation();
      });
  }, [runPendingNavigation]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        clearPendingNavigation();
        return;
      }

      setLeaveDraftPromptOpen(open);
    },
    [clearPendingNavigation],
  );

  const leaveDraftDialogProps = useMemo<AgentBuilderLeaveDraftDialogProps>(
    () => ({
      open: leaveDraftPromptOpen,
      onOpenChange: handleOpenChange,
      onCancel: handleCancelLeaveDraft,
      onDiscard: handleDiscardLeaveDraft,
      onKeep: runPendingNavigation,
    }),
    [
      handleCancelLeaveDraft,
      handleDiscardLeaveDraft,
      handleOpenChange,
      leaveDraftPromptOpen,
      runPendingNavigation,
    ],
  );

  return {
    guardNavigation,
    start,
    create,
    onSaved,
    leaveDraftDialogProps,
  };
}
