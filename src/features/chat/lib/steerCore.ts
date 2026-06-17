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
  appendAttachmentPaths,
  buildAcpImages,
  buildMessageAttachments,
} from "./attachments";
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
  const images = buildAcpImages(attachments);
  const hasAttachments = (attachments?.length ?? 0) > 0;
  const activeRunId = useChatStore
    .getState()
    .getSessionRuntime(sessionId).activeRunId;

  if (!text.trim() && !hasAttachments) {
    return false;
  }

  const userMessage = createUserMessage(
    sendOptions?.displayText ?? text,
    buildMessageAttachments(attachments),
    sendOptions?.chips,
  );
  userMessage.metadata = {
    ...userMessage.metadata,
    ...sendOptions?.userMessageMetadata,
    delivery: "steer",
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

  const promptWithPaths = appendAttachmentPaths(text.trim(), attachments);
  const acpPrompt = promptWithPaths || (images?.length ? " " : promptWithPaths);
  const chatStore = useChatStore.getState();
  chatStore.addMessage(sessionId, userMessage);
  chatStore.setPendingInterventionBoundary(sessionId, {
    interventionMessageId: userMessage.id,
  });

  try {
    const steeredRunId = await acpSteerMessage(
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
    useChatStore.getState().setActiveRunId(sessionId, steeredRunId);
    useChatSessionStore.getState().patchSession(sessionId, {
      updatedAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    const liveStore = useChatStore.getState();
    liveStore.removeMessage(sessionId, userMessage.id);
    if (
      liveStore.getSessionRuntime(sessionId).pendingInterventionBoundary
        ?.interventionMessageId === userMessage.id
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
