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

const reservedDeliveryIds = new Set<string>();

export class BerdctlDeliveryAlreadyAcceptedError extends Error {
  constructor() {
    super("The Berd delivery was already accepted.");
    this.name = "BerdctlDeliveryAlreadyAcceptedError";
  }
}

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
    hasAcceptedBerdctlDeliveryInTranscript(sessionId, deliveryId) ||
    (chatStore.queuedMessageBySession[sessionId] ?? []).some(
      (record) =>
        record.payload.sendOptions?.userMessageMetadata?.berdDeliveryId ===
        deliveryId,
    )
  );
}

export function hasAcceptedBerdctlDeliveryInTranscript(
  sessionId: string,
  deliveryId: string,
): boolean {
  return (useChatStore.getState().messagesBySession[sessionId] ?? []).some(
    (message) => message.metadata?.berdDeliveryId === deliveryId,
  );
}

export function reserveBerdctlDelivery(
  sessionId: string,
  deliveryId: string,
): (() => void) | null {
  const key = JSON.stringify([sessionId, deliveryId]);
  if (
    reservedDeliveryIds.has(key) ||
    hasAcceptedBerdctlDelivery(sessionId, deliveryId)
  ) {
    return null;
  }
  reservedDeliveryIds.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reservedDeliveryIds.delete(key);
  };
}

export async function sendPromptToExistingSessionInBackground(
  sessionId: string,
  prompt: string,
  beforeUserMessageCommitted?: () => void,
  options: {
    returnOnDispatch?: boolean;
    sendOptions?: ChatSendOptions;
    validateHydratedTranscript?: () => void;
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
      options.validateHydratedTranscript?.();
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
