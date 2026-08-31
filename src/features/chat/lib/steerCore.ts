import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { acpSteerMessage } from "@/shared/api/acp";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import {
  type ChatAttachmentDraft,
  createSystemNotificationMessage,
  createUserMessage,
} from "@/shared/types/messages";
import type { ChatSendOptions } from "../types";
import {
  formatAttachmentsTooLargeMessage,
  MAX_PROMPT_ATTACHMENT_BYTES,
  promptAttachmentBytes,
  PromptPayloadTooLargeError,
} from "./attachmentPayloadBudget";
import {
  appendAttachmentPaths,
  buildAcpImages,
  buildMessageAttachments,
  remoteSafeAttachments,
} from "./attachments";
import { isSessionRunning } from "./sessionActivity";
import { getSessionPromptOwner } from "./sessionPromptOwnership";
import { i18n } from "@/shared/i18n";

function formatSteerErrorMessage(error: unknown): string {
  const message = formatAcpErrorMessage(error);
  return message.toLowerCase().includes("method not found")
    ? i18n.t("chat:errors.steeringBackendUnavailable")
    : message;
}

export async function steerPromptInSession(
  sessionId: string,
  text: string,
  attachments?: ChatAttachmentDraft[],
  sendOptions?: ChatSendOptions,
  options: { throwOnError?: boolean } = {},
): Promise<boolean> {
  const sessionRunsRemotely = Boolean(
    useChatSessionStore.getState().getSession(sessionId)?.remoteHost,
  );
  const dispatchAttachments = sessionRunsRemotely
    ? remoteSafeAttachments(attachments)
    : attachments;
  const images = buildAcpImages(dispatchAttachments);
  const hasAttachments = (dispatchAttachments?.length ?? 0) > 0;
  const activeRunId = useChatStore
    .getState()
    .getSessionRuntime(sessionId).activeRunId;
  const promptOwner = getSessionPromptOwner(sessionId);

  if (!text.trim() && !hasAttachments) {
    return false;
  }

  // Defense-in-depth mirror of the dispatchPrompt guard: the composer
  // already budget-checks steers synchronously, but non-composer callers
  // (berdctl, queued steers) reach here directly. An oversized ACP message
  // silently kills the shared WebSocket and every open chat (BOT-1463), so
  // reject before committing anything.
  const attachmentBytes = promptAttachmentBytes(dispatchAttachments);
  if (attachmentBytes > MAX_PROMPT_ATTACHMENT_BYTES) {
    const errorMessage = formatAttachmentsTooLargeMessage(attachmentBytes);
    useChatStore
      .getState()
      .addMessage(
        sessionId,
        createSystemNotificationMessage(errorMessage, "error"),
      );
    if (options.throwOnError) {
      throw new PromptPayloadTooLargeError(errorMessage);
    }
    return false;
  }

  const userMessage = createUserMessage(
    sendOptions?.displayText ?? text,
    buildMessageAttachments(dispatchAttachments),
    sendOptions?.chips,
  );
  userMessage.metadata = {
    ...userMessage.metadata,
    ...sendOptions?.userMessageMetadata,
    delivery: "steering",
    steeringRequestId: userMessage.id,
  };

  if (images && images.length > 0) {
    for (const img of images) {
      userMessage.content.push({
        type: "image",
        data: img.base64,
        mimeType: img.mimeType,
      });
    }
  }

  const promptWithPaths = appendAttachmentPaths(
    text.trim(),
    dispatchAttachments,
  );
  const acpPrompt = promptWithPaths || (images?.length ? " " : promptWithPaths);
  const chatStore = useChatStore.getState();
  chatStore.addMessage(sessionId, userMessage);
  chatStore.setPendingInterventionBoundary(sessionId, {
    interventionMessageId: userMessage.id,
  });

  try {
    const steerResponse = await acpSteerMessage(
      sessionId,
      activeRunId,
      acpPrompt,
      {
        ...(sendOptions?.assistantPrompt
          ? { assistantPrompt: sendOptions.assistantPrompt }
          : {}),
        goose: sendOptions?.acpGooseMetadata,
        images: images?.map(
          (img) => [img.base64, img.mimeType] as [string, string],
        ),
      },
    );
    const steeredRunId = steerResponse.runId;
    const liveStore = useChatStore.getState();
    liveStore.replaceMessageId(
      sessionId,
      userMessage.id,
      steerResponse.messageId,
    );
    const acknowledgedMessage =
      liveStore.messagesBySession[sessionId]?.find(
        (message) => message.id === steerResponse.messageId,
      ) ?? userMessage;
    const deliveryArrivedBeforeAcknowledgement =
      acknowledgedMessage.metadata?.delivery === "steer";
    if (!deliveryArrivedBeforeAcknowledgement) {
      liveStore.updateMessage(
        sessionId,
        steerResponse.messageId,
        (message) => ({
          ...message,
          metadata: {
            ...message.metadata,
            delivery: "steering",
          },
        }),
      );
    }
    if (
      deliveryArrivedBeforeAcknowledgement &&
      liveStore.getSessionRuntime(sessionId).pendingInterventionBoundary
        ?.interventionMessageId === steerResponse.messageId
    ) {
      liveStore.setPendingInterventionBoundary(sessionId, null);
    }
    const liveRuntime = liveStore.getSessionRuntime(sessionId);
    const promptStillOwnsSession =
      promptOwner !== null && getSessionPromptOwner(sessionId) === promptOwner;
    const runIsStillActive =
      (liveRuntime.activeRunId === steeredRunId ||
        liveRuntime.activeRunId === activeRunId) &&
      (activeRunId !== null || promptStillOwnsSession) &&
      !liveRuntime.isRunCancellationPending &&
      isSessionRunning(liveRuntime.chatState);
    // A stop or natural completion can finish the run while steer is awaiting
    // its acknowledgement. Do not restore that stale run after it has ended.
    if (runIsStillActive) {
      liveStore.setActiveRunId(sessionId, steeredRunId);
    }
    useChatSessionStore.getState().patchSession(sessionId, {
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const liveStore = useChatStore.getState();
    const liveMessage = liveStore.messagesBySession[sessionId]?.find(
      (message) =>
        message.id === userMessage.id ||
        message.metadata?.steeringRequestId === userMessage.id,
    );
    const deliveryWasEstablished = liveMessage?.metadata?.delivery === "steer";
    if (!deliveryWasEstablished) {
      const liveMessageId = liveMessage?.id ?? userMessage.id;
      liveStore.removeMessage(sessionId, liveMessageId);
      if (
        liveStore.getSessionRuntime(sessionId).pendingInterventionBoundary
          ?.interventionMessageId === liveMessageId
      ) {
        liveStore.setPendingInterventionBoundary(sessionId, null);
      }
      const errorMessage = formatSteerErrorMessage(err);
      liveStore.addMessage(
        sessionId,
        createSystemNotificationMessage(errorMessage, "error"),
      );
      if (options.throwOnError) {
        throw new Error(errorMessage);
      }
      return false;
    }
  }
  // Unlike sendCore, the user-message append above is provisional — the catch
  // rolls it back when the steer never reached the backend. The commit
  // callback therefore fires here instead, once the message is durably
  // committed: after acknowledgement, or after delivery was established
  // despite an acknowledgement error. It runs outside the try so a throwing
  // callback cannot trip the rollback of an acknowledged steer. Callers that
  // do not wire it (berdctl, voice conversation) get no commit notification.
  sendOptions?.onUserMessageCommitted?.();
  return true;
}
