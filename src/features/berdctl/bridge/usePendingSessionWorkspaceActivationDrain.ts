import { useEffect } from "react";

import {
  applyPendingSessionWorkspaceActivation,
  listPendingSessionWorkspaceActivations,
  subscribeToPendingSessionWorkspaceActivations,
} from "@/features/chat/lib/sessionWorkspaceActivation";
import {
  isSessionRuntimeSettled,
  useChatStore,
} from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { createSystemNotificationMessage } from "@/shared/types/messages";

const drainingSessionIds = new Set<string>();
const reportedFailureRequestIds = new Set<string>();

interface ActivationDrainOptions {
  allowWindowed?: boolean;
  sessionId?: string;
}

function drainReadyActivations(options: ActivationDrainOptions = {}): void {
  for (const activation of listPendingSessionWorkspaceActivations()) {
    if (options.sessionId && activation.sessionId !== options.sessionId)
      continue;
    if (drainingSessionIds.has(activation.sessionId)) continue;
    if (!useChatSessionStore.getState().getSession(activation.sessionId)) {
      continue;
    }
    const windowState = useSessionWindowStore.getState();
    if (!options.allowWindowed && !windowState.hasLoadedSnapshot) continue;
    if (
      !options.allowWindowed &&
      windowState.isOpenInWindow(activation.sessionId)
    ) {
      continue;
    }
    const runtime = useChatStore
      .getState()
      .getSessionRuntime(activation.sessionId);
    if (!isSessionRuntimeSettled(runtime)) continue;

    drainingSessionIds.add(activation.sessionId);
    void applyPendingSessionWorkspaceActivation(activation.sessionId)
      .catch((error) => {
        console.error(
          `[workspace-activation] failed for session ${activation.sessionId}`,
          error,
        );
        if (!reportedFailureRequestIds.has(activation.requestId)) {
          reportedFailureRequestIds.add(activation.requestId);
          const stillPending = listPendingSessionWorkspaceActivations().some(
            (pending) => pending.requestId === activation.requestId,
          );
          const message = stillPending
            ? `Couldn’t switch this chat to ${activation.path}. The switch will be retried before the next prompt. ${String(error)}`
            : `Couldn’t switch this chat to ${activation.path}. The pending switch was canceled. ${String(error)}`;
          const chatStore = useChatStore.getState();
          chatStore.addMessage(
            activation.sessionId,
            createSystemNotificationMessage(message, "error"),
          );
          chatStore.setError(activation.sessionId, message);
        }
      })
      .finally(() => {
        drainingSessionIds.delete(activation.sessionId);
        const latest = listPendingSessionWorkspaceActivations().find(
          (pending) => pending.sessionId === activation.sessionId,
        );
        if (latest && latest.requestId !== activation.requestId) {
          drainReadyActivations(options);
        }
      });
  }
}

/** Applies persisted workspace switches as soon as their sessions settle. */
export function usePendingSessionWorkspaceActivationDrain(
  options: ActivationDrainOptions = {},
): void {
  const allowWindowed = options.allowWindowed ?? false;
  const sessionId = options.sessionId;
  useEffect(() => {
    const drainOptions = { allowWindowed, sessionId };
    const drain = () => drainReadyActivations(drainOptions);
    drain();
    const unsubscribePending =
      subscribeToPendingSessionWorkspaceActivations(drain);
    const unsubscribeChat = useChatStore.subscribe((state, previousState) => {
      if (state.sessionStateById !== previousState.sessionStateById) {
        drain();
      }
    });
    const unsubscribeWindows = useSessionWindowStore.subscribe(
      (state, previousState) => {
        if (state.openSessions !== previousState.openSessions) {
          drain();
        }
      },
    );
    const unsubscribeSessions = useChatSessionStore.subscribe(
      (state, previousState) => {
        if (
          state.hasHydratedSessions !== previousState.hasHydratedSessions ||
          state.sessions !== previousState.sessions
        ) {
          drain();
        }
      },
    );
    return () => {
      unsubscribePending();
      unsubscribeChat();
      unsubscribeWindows();
      unsubscribeSessions();
    };
  }, [allowWindowed, sessionId]);
}
