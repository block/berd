import { useAgentStore } from "@/features/agents/stores/agentStore";
import {
  appendAttachmentPaths,
  buildAcpImages,
  buildMessageAttachments,
} from "@/features/chat/lib/attachments";
import {
  getSessionTitleFromDraft,
  isDefaultChatTitle,
} from "@/features/chat/lib/sessionTitle";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { acpSendMessage } from "@/shared/api/acp";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { perfLog } from "@/shared/lib/perfLog";
import {
  type ChatAttachmentDraft,
  type MessageChip,
  createSystemNotificationMessage,
  createUserMessage,
} from "@/shared/types/messages";

/** Persona recorded on the user message and forwarded to the ACP send. */
export interface SendCorePersona {
  id: string;
  name?: string;
}

export interface SendCoreOptions {
  persona?: SendCorePersona;
  /** Attachment drafts included with the foreground prompt. */
  attachments?: ChatAttachmentDraft[];
  /** Assistant-audience prompt (skills/builder) merged ahead of the user text. */
  assistantPrompt?: string;
  /** Text shown in the transcript when it differs from the prompt sent. */
  displayText?: string;
  /** User-visible chips stored on the user message's metadata. */
  chips?: MessageChip[];
  /** Pending-assistant provider; defaults to the active agent's provider. */
  providerId?: string;
  /**
   * Fire-and-forget background send used by goosectl; keeps prompt whitespace
   * intact and skips foreground dispatch perf logs.
   */
  background?: boolean;
  /**
   * System prompt forwarded verbatim to the ACP send. The caller owns fallback
   * policy; useChat falls back to the active agent's prompt before dispatching.
   */
  systemPrompt?: string;
  /**
   * Runs between the "thinking" and "streaming" transitions; a throw routes
   * through the shared error path.
   */
  prepare?: () => Promise<void>;
  signal?: AbortSignal;
  /**
   * Fires synchronously after the user message and title patch are committed
   * to the stores, before any awaits.
   */
  onUserMessageCommitted?: () => void;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }

  throw new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Foreground send core: commits the user message, drives the
 * thinking-to-streaming-to-idle chat-state transitions, patches the session
 * title, and dispatches the prompt over ACP.
 * Background sends use the same store transitions without foreground perf
 * logging.
 *
 * Rejects with the original error after recording it: on failure the
 * streaming message is marked errored and a system-notification message is
 * appended to the transcript; on AbortError the session just returns to idle.
 */
export async function dispatchPrompt(
  sessionId: string,
  text: string,
  opts: SendCoreOptions,
): Promise<void> {
  const sid = sessionId.slice(0, 8);
  const tSendStart = performance.now();
  const {
    assistantPrompt,
    attachments,
    background,
    chips,
    displayText,
    onUserMessageCommitted,
    persona,
    prepare,
    providerId,
    signal,
    systemPrompt,
  } = opts;
  const images = buildAcpImages(attachments);

  const {
    addMessage,
    setChatState,
    setError,
    setStreamingMessageId,
    setPendingAssistantProvider,
  } = useChatStore.getState();

  const agent = useAgentStore.getState().getActiveAgent();
  const pendingAssistantProvider = providerId ?? agent?.provider ?? "goose";

  setPendingAssistantProvider(sessionId, pendingAssistantProvider);

  // Create and add user message.
  const userMessage = createUserMessage(
    displayText ?? text,
    buildMessageAttachments(attachments),
    chips,
  );
  if (persona) {
    userMessage.metadata = {
      ...userMessage.metadata,
      targetPersonaId: persona.id,
      targetPersonaName: persona.name,
    };
  }
  // Embed image content blocks into the user message for local display.
  if (images && images.length > 0) {
    for (const img of images) {
      userMessage.content.push({
        type: "image",
        data: img.base64,
        mimeType: img.mimeType,
      });
    }
  }
  addMessage(sessionId, userMessage);
  setChatState(sessionId, "thinking");
  setError(sessionId, null);

  const sessionStore = useChatSessionStore.getState();
  const session = sessionStore.getSession(sessionId);

  // Immediately set the session/sidebar title from the user's message when
  // the session still has the default placeholder. This gives instant feedback
  // instead of waiting for acp:done or acp:session_info. A better
  // backend-generated title will overwrite this if it arrives via the
  // acp:session_info event.
  if (session && isDefaultChatTitle(session.title)) {
    sessionStore.patchSession(sessionId, {
      title: getSessionTitleFromDraft(text, attachments),
      updatedAt: new Date().toISOString(),
    });
  } else {
    sessionStore.patchSession(sessionId, {
      updatedAt: new Date().toISOString(),
    });
  }
  sessionStore.updateSessionSubtitleFromText(sessionId, text);

  onUserMessageCommitted?.();

  try {
    throwIfAborted(signal);
    await prepare?.();
    throwIfAborted(signal);

    setChatState(sessionId, "streaming");
    throwIfAborted(signal);
    const promptWithPaths = appendAttachmentPaths(
      background ? text : text.trim(),
      attachments,
    );
    const acpPrompt =
      promptWithPaths || (images?.length ? " " : promptWithPaths);
    const tAcp = performance.now();
    if (!background) {
      perfLog(
        `[perf:send] ${sid} → acpSendMessage (setup took ${(tAcp - tSendStart).toFixed(1)}ms)`,
      );
    }
    await acpSendMessage(sessionId, acpPrompt, {
      systemPrompt,
      ...(assistantPrompt ? { assistantPrompt } : {}),
      personaId: persona?.id,
      personaName: persona?.name,
      images: images?.map(
        (img) => [img.base64, img.mimeType] as [string, string],
      ),
    });
    if (!background) {
      perfLog(
        `[perf:send] ${sid} acpSendMessage returned after ${(performance.now() - tAcp).toFixed(1)}ms (total dispatchPrompt ${(performance.now() - tSendStart).toFixed(1)}ms)`,
      );
    }

    setChatState(sessionId, "idle");
    setStreamingMessageId(sessionId, null);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      setChatState(sessionId, "idle");
    } else {
      const errorMessage = formatAcpErrorMessage(err);
      const liveStore = useChatStore.getState();
      const { streamingMessageId } = liveStore.getSessionRuntime(sessionId);
      if (streamingMessageId) {
        liveStore.updateMessage(sessionId, streamingMessageId, (message) => ({
          ...message,
          metadata: {
            ...message.metadata,
            completionStatus: "error",
          },
        }));
      }

      liveStore.addMessage(
        sessionId,
        createSystemNotificationMessage(errorMessage, "error"),
      );
      setError(sessionId, errorMessage);
      setChatState(sessionId, "idle");
      setStreamingMessageId(sessionId, null);
    }
    setPendingAssistantProvider(sessionId, null);
    throw err;
  }
}
