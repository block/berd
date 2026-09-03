import { PreCommitSendRejectedError } from "@/features/chat/lib/preCommitSendRejection";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import {
  appendAttachmentPaths,
  buildAcpImages,
  buildMessageAttachments,
  remoteSafeAttachments,
} from "@/features/chat/lib/attachments";
import {
  getSessionTitleFromDraft,
  isDefaultChatTitle,
} from "@/features/chat/lib/sessionTitle";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  clearBufferedStreamingUpdatesForSession,
  clearLiveSubtitleUpdate,
  flushBufferedStreamingUpdatesForSession,
} from "@/features/chat/acp/liveStreamingUpdates";
import { acpExportSession, acpSendMessage } from "@/shared/api/acp";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { messagesFromKgooseSessionExport } from "@/shared/api/kgooseMessages";
import {
  formatAttachmentsTooLargeMessage,
  MAX_PROMPT_ATTACHMENT_BYTES,
  promptAttachmentBytes,
  PromptPayloadTooLargeError,
} from "@/features/chat/lib/attachmentPayloadBudget";
import {
  claimSessionPrompt,
  getSessionPromptOwner,
  ownsSessionPrompt,
  releaseSessionPrompt,
} from "@/features/chat/lib/sessionPromptOwnership";
import { perfLog } from "@/shared/lib/perfLog";
import { completeAssistantMessage } from "@/features/chat/lib/messageCompletion";
import { isVoiceConversationEmptyResponse } from "@/features/chat/lib/voiceConversationNoop";
import {
  completeActiveRealtimeMasterTurn,
  hasActiveRealtimeEmissary,
  hasLocalActiveRealtimeEmissary,
} from "@/features/voice-conversation/lib/realtimeEmissaryBridge";
import { getVoiceConversationMode } from "@/features/voice-conversation/lib/voiceConversationModePreference";
import {
  type ChatAttachmentDraft,
  type Message,
  type MessageMetadata,
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
  /** Reuses a provisional local transcript row when the send commits. */
  userMessageId?: string;
  /** User-visible chips stored on the user message's metadata. */
  chips?: MessageChip[];
  /** Extra renderer-only metadata to stamp on the local user message. */
  userMessageMetadata?: Partial<MessageMetadata>;
  /** Extra metadata persisted through ACP under `_meta.goose`. */
  acpGooseMetadata?: Record<string, unknown>;
  /** Pending-assistant provider; defaults to the active agent's provider. */
  providerId?: string;
  /**
   * Fire-and-forget background send used by berdctl; keeps prompt whitespace
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
  prepare?: () => void | Promise<void>;
  signal?: AbortSignal;
  /** Fires immediately before the user message is committed to local stores. */
  beforeUserMessageCommitted?: () => void;
  /**
   * Fires synchronously after the user message and title patch are committed
   * to the stores, before any awaits.
   */
  onUserMessageCommitted?: () => void;
  /** Fires once preparation succeeds and the ACP prompt invocation starts. */
  onPromptDispatched?: () => void;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }

  throw new DOMException("The operation was aborted.", "AbortError");
}

function finalMasterTextSince(
  sessionId: string,
  existingAssistantTextById: ReadonlyMap<string, string>,
): string | undefined {
  const messages = useChatStore.getState().messagesBySession[sessionId] ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      !message ||
      message.role !== "assistant" ||
      message.metadata?.origin === "voice_conversation" ||
      message.metadata?.agentVisible === false
    ) {
      continue;
    }
    const text = message.content
      .flatMap((content) => (content.type === "text" ? [content.text] : []))
      .join("\n")
      .trim();
    if (isVoiceConversationEmptyResponse(text)) continue;
    if (text && existingAssistantTextById.get(message.id) !== text) return text;
  }
  return undefined;
}

function assistantTextSnapshot(sessionId: string): ReadonlyMap<string, string> {
  const messages = useChatStore.getState().messagesBySession[sessionId] ?? [];
  return new Map(
    messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          message.metadata?.origin !== "voice_conversation" &&
          message.metadata?.agentVisible !== false,
      )
      .map((message) => [
        message.id,
        message.content
          .flatMap((content) => (content.type === "text" ? [content.text] : []))
          .join("\n")
          .trim(),
      ]),
  );
}

function realtimeHandoffReminderIds(
  metadata: Record<string, unknown> | undefined,
): string[] {
  const value = metadata?.realtimeHandoffReminderIds;
  return Array.isArray(value)
    ? value.filter(
        (handoffId): handoffId is string =>
          typeof handoffId === "string" && handoffId.length > 0,
      )
    : [];
}

function messageText(message: Message): string {
  return message.content
    .flatMap((content) => (content.type === "text" ? [content.text] : []))
    .join("\n");
}

async function recoverMissingMasterTranscript(
  sessionId: string,
  prompt: string,
): Promise<void> {
  try {
    const exportedMessages = messagesFromKgooseSessionExport(
      await acpExportSession(sessionId),
    );
    const promptBoundary = exportedMessages.findLastIndex(
      (message) =>
        message.role === "user" && messageText(message).includes(prompt),
    );
    if (promptBoundary < 0) return;

    const recovered = exportedMessages
      .slice(promptBoundary + 1)
      .filter((message) => message.role === "assistant");
    if (!recovered.length) return;

    const current = useChatStore.getState().messagesBySession[sessionId] ?? [];
    const recoveredById = new Map(
      recovered.map((message) => [message.id, message]),
    );
    const merged = current
      .map((message) => recoveredById.get(message.id) ?? message)
      .concat(
        recovered.filter(
          (message) => !current.some((existing) => existing.id === message.id),
        ),
      )
      .map((message, index) => ({ message, index }))
      .sort((left, right) =>
        left.message.created === right.message.created
          ? left.index - right.index
          : left.message.created - right.message.created,
      )
      .map(({ message }) => message);
    useChatStore.getState().setMessages(sessionId, merged);
  } catch (error) {
    console.warn("Failed to recover completed Master transcript", error);
  }
}

async function settleMasterTranscriptDelivery(
  sessionId: string,
): Promise<void> {
  if (useChatStore.getState().loadingSessionIds.has(sessionId)) {
    await new Promise<void>((resolve) => {
      const unsubscribe = useChatStore.subscribe((state) => {
        if (state.loadingSessionIds.has(sessionId)) return;
        unsubscribe();
        resolve();
      });
    });
  }
  // ACP may resolve session/prompt immediately before dispatching the final
  // session/update already read from the same transport. Yield one macrotask
  // so transcript recovery sees that last visible text block.
  // Keep ownership through new-session hydration as well: a late live chunk
  // routed after ownership is released looks like replay and can be discarded
  // by the hydration snapshot that is finishing at the same boundary.
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

type AssistantPromptOutcome = "completed" | "error";

interface AssistantCancellationRace {
  sessionId: string;
  messageId: string;
  cancellationResult?: boolean;
  promptOutcome?: AssistantPromptOutcome;
}

const assistantCancellationRaces = new Map<symbol, AssistantCancellationRace>();

function completeAssistantMessageById(
  sessionId: string,
  messageId: string | null,
): void {
  if (!messageId) return;
  useChatStore
    .getState()
    .updateMessage(sessionId, messageId, completeAssistantMessage);
}

function markAssistantMessageErrored(
  sessionId: string,
  messageId: string,
): void {
  useChatStore.getState().updateMessage(sessionId, messageId, (message) => ({
    ...message,
    metadata: { ...message.metadata, completionStatus: "error" },
  }));
}

function finalizeAssistantCancellationRace(promptOwner: symbol): void {
  const race = assistantCancellationRaces.get(promptOwner);
  if (!race || race.cancellationResult === undefined) return;
  if (race.cancellationResult) {
    assistantCancellationRaces.delete(promptOwner);
    return;
  }
  if (!race.promptOutcome) return;

  if (race.promptOutcome === "completed") {
    completeAssistantMessageById(race.sessionId, race.messageId);
  } else {
    markAssistantMessageErrored(race.sessionId, race.messageId);
  }
  assistantCancellationRaces.delete(promptOwner);
}

export function registerAssistantCancellationTarget(
  sessionId: string,
  messageId: string,
): symbol | null {
  const promptOwner = getSessionPromptOwner(sessionId);
  if (!promptOwner) return null;
  assistantCancellationRaces.set(promptOwner, { sessionId, messageId });
  return promptOwner;
}

function recordAssistantPromptOutcome(
  promptOwner: symbol,
  outcome: AssistantPromptOutcome,
): void {
  const race = assistantCancellationRaces.get(promptOwner);
  if (!race) return;
  race.promptOutcome = outcome;
  finalizeAssistantCancellationRace(promptOwner);
}

export function resolveAssistantCancellation(
  promptOwner: symbol | null,
  cancelled: boolean,
): void {
  if (!promptOwner) return;
  const race = assistantCancellationRaces.get(promptOwner);
  if (!race) return;
  race.cancellationResult = cancelled;
  finalizeAssistantCancellationRace(promptOwner);
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
    acpGooseMetadata,
    attachments,
    background,
    beforeUserMessageCommitted,
    chips,
    displayText,
    onPromptDispatched,
    onUserMessageCommitted,
    persona,
    prepare,
    providerId,
    signal,
    systemPrompt,
    userMessageMetadata,
    userMessageId,
  } = opts;
  const sessionRunsRemotely = Boolean(
    useChatSessionStore.getState().getSession(sessionId)?.remoteHost,
  );
  const dispatchAttachments = sessionRunsRemotely
    ? remoteSafeAttachments(attachments)
    : attachments;
  const images = buildAcpImages(dispatchAttachments);

  // Reject oversized attachment payloads before committing anything: an
  // overflowing ACP WebSocket message silently kills the shared connection
  // and every open chat with it (BOT-1463). Failing here keeps the draft in
  // the composer so the user can remove attachments and retry.
  const attachmentBytes = promptAttachmentBytes(dispatchAttachments);
  if (attachmentBytes > MAX_PROMPT_ATTACHMENT_BYTES) {
    const errorMessage = formatAttachmentsTooLargeMessage(attachmentBytes);
    useChatStore.getState().setError(sessionId, errorMessage);
    throw new PromptPayloadTooLargeError(errorMessage);
  }

  const promptOwner = claimSessionPrompt(sessionId);
  const shouldCoordinateRealtime =
    hasLocalActiveRealtimeEmissary(sessionId) ||
    getVoiceConversationMode() === "openai-realtime";
  const assistantTextBeforeTurn = shouldCoordinateRealtime
    ? assistantTextSnapshot(sessionId)
    : undefined;
  const isCurrent = () => ownsSessionPrompt(sessionId, promptOwner);
  let userMessageCommitted = false;
  let preCommitRejected = false;
  let dispatchedPrompt = text;

  const { addMessage, setChatState, setError, setPendingAssistantProvider } =
    useChatStore.getState();

  const agent = useAgentStore.getState().getActiveAgent();
  const pendingAssistantProvider = providerId ?? agent?.provider ?? "goose";

  setPendingAssistantProvider(sessionId, pendingAssistantProvider);
  clearLiveSubtitleUpdate(sessionId);

  const finishPromptSuccessfully = () => {
    const cancellationRace = assistantCancellationRaces.get(promptOwner);
    if (cancellationRace) {
      flushBufferedStreamingUpdatesForSession(sessionId, {
        flushSubtitle: true,
        owner: promptOwner,
      });
      recordAssistantPromptOutcome(promptOwner, "completed");
    } else if (isCurrent()) {
      const ownedStreamingMessageId = useChatStore
        .getState()
        .getSessionRuntime(sessionId).streamingMessageId;
      flushBufferedStreamingUpdatesForSession(sessionId, {
        flushSubtitle: true,
        owner: promptOwner,
      });
      completeAssistantMessageById(sessionId, ownedStreamingMessageId);
      if (isCurrent()) {
        setChatState(sessionId, "idle");
      }
    }
  };

  const completeRealtimeTurnIfActive = async (prompt: string) => {
    const shouldCoordinateAtCompletion =
      shouldCoordinateRealtime ||
      hasLocalActiveRealtimeEmissary(sessionId) ||
      getVoiceConversationMode() === "openai-realtime";
    if (
      !shouldCoordinateAtCompletion ||
      !(await hasActiveRealtimeEmissary(sessionId))
    ) {
      return;
    }
    await settleMasterTranscriptDelivery(sessionId);
    if (
      assistantTextBeforeTurn &&
      !finalMasterTextSince(sessionId, assistantTextBeforeTurn)
    ) {
      await recoverMissingMasterTranscript(sessionId, prompt);
    }
    await completeActiveRealtimeMasterTurn(sessionId, {
      reminderHandoffIds: realtimeHandoffReminderIds(acpGooseMetadata),
    });
  };

  try {
    // Preparation can be superseded or aborted. Complete it before committing
    // local transcript state so a retained queued record can retry without
    // duplicating the user turn.
    throwIfAborted(signal);
    await prepare?.();
    throwIfAborted(signal);

    const commitUserMessage = () => {
      throwIfAborted(signal);
      beforeUserMessageCommitted?.();
      const userMessage = createUserMessage(
        displayText ?? text,
        buildMessageAttachments(dispatchAttachments),
        chips,
      );
      if (userMessageId) userMessage.id = userMessageId;
      if (persona) {
        userMessage.metadata = {
          ...userMessage.metadata,
          targetPersonaId: persona.id,
          targetPersonaName: persona.name,
        };
      }
      if (userMessageMetadata) {
        userMessage.metadata = {
          ...userMessage.metadata,
          ...userMessageMetadata,
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
      const provisionalMessage = userMessageId
        ? useChatStore
            .getState()
            .messagesBySession[sessionId]?.some(
              (message) => message.id === userMessageId,
            )
        : false;
      if (provisionalMessage) {
        useChatStore
          .getState()
          .updateMessage(sessionId, userMessage.id, (existing) => ({
            ...userMessage,
            created: existing.created,
          }));
      } else {
        addMessage(sessionId, userMessage);
      }
      userMessageCommitted = true;
      setChatState(sessionId, "thinking");
      setError(sessionId, null);

      const sessionStore = useChatSessionStore.getState();
      const session = sessionStore.getSession(sessionId);
      if (session && isDefaultChatTitle(session.title)) {
        sessionStore.patchSession(sessionId, {
          title: getSessionTitleFromDraft(text, dispatchAttachments),
          updatedAt: new Date().toISOString(),
        });
      } else {
        sessionStore.patchSession(sessionId, {
          updatedAt: new Date().toISOString(),
        });
      }
      sessionStore.updateSessionSubtitleFromText(sessionId, text);
      onUserMessageCommitted?.();
      sessionStore.markWorkspaceUsedByAgent(sessionId);
      setChatState(sessionId, "streaming");
    };

    const promptWithPaths = appendAttachmentPaths(
      background ? text : text.trim(),
      dispatchAttachments,
    );
    const acpPrompt =
      promptWithPaths || (images?.length ? " " : promptWithPaths);
    dispatchedPrompt = acpPrompt;
    const tAcp = performance.now();
    if (!background) {
      perfLog(
        `[perf:send] ${sid} → acpSendMessage (setup took ${(tAcp - tSendStart).toFixed(1)}ms)`,
      );
    }
    const promptPromise = acpSendMessage(sessionId, acpPrompt, {
      systemPrompt,
      ...(assistantPrompt ? { assistantPrompt } : {}),
      personaId: persona?.id,
      personaName: persona?.name,
      goose: acpGooseMetadata,
      images: images?.map(
        (img) => [img.base64, img.mimeType] as [string, string],
      ),
      onPromptDispatching: commitUserMessage,
      onPromptDispatched: () => {
        onPromptDispatched?.();
      },
    });
    await promptPromise;
    if (!background) {
      perfLog(
        `[perf:send] ${sid} acpSendMessage returned after ${(performance.now() - tAcp).toFixed(1)}ms (total dispatchPrompt ${(performance.now() - tSendStart).toFixed(1)}ms)`,
      );
    }

    finishPromptSuccessfully();
    try {
      await completeRealtimeTurnIfActive(acpPrompt);
    } catch (error) {
      console.warn("Could not complete the Realtime Expert turn", error);
    }
  } catch (err) {
    const isVoiceConversationNoop =
      userMessageCommitted &&
      userMessageMetadata?.origin === "voice_conversation" &&
      isVoiceConversationEmptyResponse(formatAcpErrorMessage(err));
    if (isVoiceConversationNoop) {
      finishPromptSuccessfully();
      try {
        await completeRealtimeTurnIfActive(dispatchedPrompt);
      } catch (error) {
        console.warn("Could not complete the Realtime Expert turn", error);
      }
      if (isCurrent()) {
        setError(sessionId, null);
        setPendingAssistantProvider(sessionId, null);
      }
      return;
    }
    preCommitRejected = err instanceof PreCommitSendRejectedError;
    if (!preCommitRejected) {
      const cancellationRace = assistantCancellationRaces.get(promptOwner);
      if (cancellationRace) {
        recordAssistantPromptOutcome(promptOwner, "error");
      }
    }
    if (preCommitRejected) {
      // Ownership/readiness changed at the last reversible boundary. This
      // prompt committed nothing, so leave the newer owner's runtime intact.
    } else if (err instanceof DOMException && err.name === "AbortError") {
      if (isCurrent()) {
        flushBufferedStreamingUpdatesForSession(sessionId, {
          flushSubtitle: true,
          owner: promptOwner,
        });
        if (isCurrent()) {
          setChatState(sessionId, "idle");
        }
      }
    } else if (isCurrent()) {
      flushBufferedStreamingUpdatesForSession(sessionId, {
        flushSubtitle: true,
        owner: promptOwner,
      });
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

      if (userMessageCommitted) {
        liveStore.addMessage(
          sessionId,
          createSystemNotificationMessage(errorMessage, "error"),
        );
      }
      setError(sessionId, errorMessage);
      if (isCurrent()) {
        setChatState(sessionId, "idle");
      }
    }
    if (!preCommitRejected && isCurrent()) {
      setPendingAssistantProvider(sessionId, null);
    }
    throw err;
  } finally {
    if (!isCurrent()) {
      clearBufferedStreamingUpdatesForSession(sessionId, {
        owner: promptOwner,
      });
    }
    if (releaseSessionPrompt(sessionId, promptOwner) && !preCommitRejected) {
      const liveStore = useChatStore.getState();
      const liveRuntime = liveStore.getSessionRuntime(sessionId);
      if (liveRuntime.isRunCancellationPending) {
        liveStore.settleActiveRun(sessionId);
      }
    }
  }
}
