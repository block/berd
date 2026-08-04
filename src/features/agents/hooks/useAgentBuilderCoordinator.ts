import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { AgentBuilderLeaveDraftDialogProps } from "../ui/AgentBuilderLeaveDraftDialog";
import {
  discardDraftAgentSession,
  hasAgentBuilderSessionUserContent,
  isDraftAgentBuilderSession,
  reconcileAgentBuilderSessions,
  resolveAgentBuilderSessionId,
  saveDraftAgentSession,
  startAgentBuilderSession,
  type StartAgentBuilderSessionDeps,
} from "../lib/agentBuilderSession";

type MaybePromise<T> = T | Promise<T>;

interface UseAgentBuilderCoordinatorOptions {
  startupReady: boolean;
  createNewTab: StartAgentBuilderSessionDeps["createNewTab"];
  closeSession: (sessionId: string) => MaybePromise<void>;
  navigateChat: (sessionId: string) => MaybePromise<void>;
}

type PendingNavigation = () => void;

interface PendingNavigationEntry {
  next: PendingNavigation;
  onCancel?: () => void;
}

export function useAgentBuilderCoordinator({
  startupReady,
  createNewTab,
  closeSession,
  navigateChat,
}: UseAgentBuilderCoordinatorOptions) {
  const { t } = useTranslation("agents");
  const [leaveDraftPromptOpen, setLeaveDraftPromptOpen] = useState(false);
  const pendingNavigationRef = useRef<PendingNavigationEntry | null>(null);
  const pendingSessionIdRef = useRef<string | null>(null);
  const pendingStartKeyRef = useRef<string | null>(null);
  const sessionsSignature = useChatSessionStore((state) =>
    state.sessions
      .map(
        (session) =>
          `${session.id}:${session.archivedAt ?? ""}:${session.intent ?? ""}:${session.targetAgentPath ?? ""}:${session.targetAgentSlug ?? ""}:${session.targetAgentDraftState ?? ""}`,
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
    const sessionId = pendingSessionIdRef.current;
    const pending = pendingNavigationRef.current;
    clearPendingNavigation();

    if (!sessionId) {
      pending?.next();
      return;
    }

    const liveSessionId = resolveAgentBuilderSessionId(sessionId);
    void saveDraftAgentSession(liveSessionId)
      .then(() => {
        pending?.next();
      })
      .catch((error) => {
        console.error("Failed to save agent draft before leaving:", error);
        toast.error(t("builderRail.saveError"));
        pending?.onCancel?.();
      });
  }, [clearPendingNavigation, t]);

  const cancelPendingNavigation = useCallback(() => {
    const pending = pendingNavigationRef.current;
    clearPendingNavigation();
    pending?.onCancel?.();
  }, [clearPendingNavigation]);

  const promptForNavigation = useCallback(
    (sessionId: string, next: PendingNavigation, onCancel?: () => void) => {
      // A newer guarded navigation supersedes any pending one; settle the old
      // entry as cancelled so its caller is not left waiting forever.
      pendingNavigationRef.current?.onCancel?.();
      pendingNavigationRef.current = { next, onCancel };
      pendingSessionIdRef.current = sessionId;
      setLeaveDraftPromptOpen(true);
    },
    [],
  );

  const guardNavigation = useCallback(
    (next: PendingNavigation, onCancel?: () => void): boolean => {
      const session = useChatSessionStore.getState().getActiveSession();
      if (
        !session ||
        session.intent !== "build-agent" ||
        session.agentBuilderOpen === false
      ) {
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

        promptForNavigation(session.id, next, onCancel);
      })().catch((error) => {
        console.error("Failed to inspect active agent draft:", error);
        promptForNavigation(session.id, next, onCancel);
      });

      return false;
    },
    [promptForNavigation],
  );

  const start = useCallback(
    (args?: { path?: string; slug?: string }) => {
      const startBuilderSession = () => {
        const startKey = `${args?.path ?? ""}\u0000${args?.slug ?? ""}`;
        if (pendingStartKeyRef.current === startKey) {
          return;
        }

        pendingStartKeyRef.current = startKey;
        clearPendingNavigation();
        void startAgentBuilderSession(args, {
          createNewTab,
          closeSession,
          navigateChat,
        })
          .catch((error) => {
            console.error("Failed to start agent builder session:", error);
            toast.error(t("builderRail.openFailed"));
          })
          .finally(() => {
            if (pendingStartKeyRef.current === startKey) {
              pendingStartKeyRef.current = null;
            }
          });
      };

      const session = useChatSessionStore.getState().getActiveSession();
      if (
        session?.intent === "build-agent" &&
        session.agentBuilderOpen !== false
      ) {
        if (!session.targetAgentPath) {
          return;
        }

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

  const handleCancelLeaveDraft = useCallback(() => {
    cancelPendingNavigation();
  }, [cancelPendingNavigation]);

  const handleDiscardLeaveDraft = useCallback(() => {
    // Capture and clear the pending entry synchronously: a concurrent guarded
    // navigation can install a new entry during the async discard gap, and a
    // re-read of the ref in .finally would hijack that newer continuation.
    const sessionId = pendingSessionIdRef.current;
    const pending = pendingNavigationRef.current;
    clearPendingNavigation();
    if (!sessionId) {
      pending?.next();
      return;
    }

    const liveSessionId = resolveAgentBuilderSessionId(sessionId);
    void discardDraftAgentSession(liveSessionId)
      .catch((error) => {
        console.error("Failed to discard agent draft:", error);
      })
      .finally(() => {
        pending?.next();
      });
  }, [clearPendingNavigation]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        cancelPendingNavigation();
        return;
      }

      setLeaveDraftPromptOpen(open);
    },
    [cancelPendingNavigation],
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
    leaveDraftDialogProps,
  };
}
