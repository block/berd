import { sendPromptInBackground } from "@/features/chat/lib/backgroundSend";
import {
  acquireExistingSessionForBackgroundSend,
  prepareExistingSessionForBackgroundSend,
  SessionDispatchContentionError,
  SessionDispatchCreationIncompleteError,
  SessionDispatchMissingError,
  SessionDispatchUnresolvedError,
} from "@/features/chat/lib/queuedSessionSend";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
export {
  sendQueuedPromptToExistingSessionInBackground,
  SessionDispatchContentionError,
  SessionDispatchCreationIncompleteError,
  SessionDispatchMissingError,
  SessionDispatchUnresolvedError,
} from "@/features/chat/lib/queuedSessionSend";
import { formatIncludedWorkspacesPrompt } from "@/features/chat/lib/workspaceAttachments";
import type { MessageMetadata } from "@/shared/types/messages";
import type { ChatSendOptions } from "@/features/chat/types";
export { isBerdctlCrossSessionQueuedMessage } from "@/features/chat/lib/queuedMessageOrigin";

export const BERDCTL_CROSS_SESSION_ORIGIN =
  "berdctl_cross_session" satisfies NonNullable<MessageMetadata["origin"]>;

export function berdctlCrossSessionSendOptions(
  options: { senderLabel?: string; deliveryId?: string } = {},
): ChatSendOptions {
  const senderMetadata = options.senderLabel
    ? { berdSenderLabel: options.senderLabel }
    : {};
  const deliveryMetadata = options.deliveryId
    ? { berdDeliveryId: options.deliveryId }
    : {};
  return {
    userMessageMetadata: {
      origin: BERDCTL_CROSS_SESSION_ORIGIN,
      ...senderMetadata,
      ...deliveryMetadata,
    },
    acpGooseMetadata: {
      origin: BERDCTL_CROSS_SESSION_ORIGIN,
      ...senderMetadata,
      ...deliveryMetadata,
    },
  };
}

export function hasAcceptedBerdctlDelivery(
  sessionId: string,
  deliveryId: string,
): boolean {
  const chatStore = useChatStore.getState();
  return (
    (chatStore.messagesBySession[sessionId] ?? []).some(
      (message) => message.metadata?.berdDeliveryId === deliveryId,
    ) ||
    (chatStore.queuedMessageBySession[sessionId] ?? []).some(
      (record) =>
        record.payload.sendOptions?.userMessageMetadata?.berdDeliveryId ===
        deliveryId,
    )
  );
}

export async function sendPromptToExistingSessionInBackground(
  sessionId: string,
  prompt: string,
  beforeUserMessageCommitted?: () => void,
  options: {
    returnOnDispatch?: boolean;
    sendOptions?: ChatSendOptions;
  } = {},
): Promise<void> {
  const acquisition = await acquireExistingSessionForBackgroundSend(sessionId);
  if (acquisition.status === "contended") {
    throw new SessionDispatchContentionError(acquisition.waiter);
  }
  if (acquisition.status === "unresolved") {
    throw new SessionDispatchUnresolvedError();
  }
  if (acquisition.status === "session-missing") {
    throw new SessionDispatchMissingError(sessionId);
  }
  if (acquisition.status === "creation-incomplete") {
    throw new SessionDispatchCreationIncompleteError(acquisition.creationState);
  }
  const targetLease = acquisition;
  let dispatched = false;
  let resolveDispatch: (() => void) | undefined;
  let rejectDispatch: ((error: unknown) => void) | undefined;
  const dispatch = options.returnOnDispatch
    ? new Promise<void>((resolve, reject) => {
        resolveDispatch = resolve;
        rejectDispatch = reject;
      })
    : null;
  const settlement = (async () => {
    try {
      const { providerId, persona } =
        await prepareExistingSessionForBackgroundSend(sessionId, {
          executionTarget: targetLease.target,
          dispatchToken: targetLease.token,
        });
      const session = useChatSessionStore.getState().getSession(sessionId);
      await sendPromptInBackground(
        sessionId,
        prompt,
        providerId,
        persona,
        {
          ...(options.sendOptions ?? berdctlCrossSessionSendOptions()),
          systemPrompt: session
            ? formatIncludedWorkspacesPrompt(session)
            : undefined,
        },
        undefined,
        beforeUserMessageCommitted,
        undefined,
        undefined,
        () => {
          dispatched = true;
          resolveDispatch?.();
        },
      );
    } catch (error) {
      if (!dispatched) rejectDispatch?.(error);
      throw error;
    } finally {
      targetLease.release();
    }
  })();
  if (!dispatch) return settlement;
  void settlement.catch(() => {
    // Pre-dispatch failures are returned through `dispatch`; post-dispatch
    // failures are already recorded and logged by the background send path.
  });
  return dispatch;
}
