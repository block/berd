import { useCallback, useRef } from "react";
import { useChatStore } from "../stores/chatStore";
import { useChatSessionStore } from "../stores/chatSessionStore";
import { clearReplayBuffer, getAndDeleteReplayBuffer } from "./replayBuffer";
import {
  type ChatAttachmentDraft,
  type Message,
  createSystemNotificationMessage,
  createUserMessage,
} from "@/shared/types/messages";
import type { ChatState, TokenState } from "@/shared/types/chat";
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";
import {
  acpSendMessage,
  acpSteerMessage,
  acpCancelSession,
  acpLoadSession,
} from "@/shared/api/acp";
import { resetPersonaHandoff } from "@/shared/api/acpPersonaHandoff";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { dispatchPrompt } from "../lib/sendCore";
import { perfLog } from "@/shared/lib/perfLog";
import {
  appendAttachmentPaths,
  buildAcpImages,
  buildMessageAttachments,
} from "../lib/attachments";
import { sanitizeReplayMessages } from "../lib/replaySanitizer";
import { i18n } from "@/shared/i18n";
import type { ChatSendOptions } from "../types";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";

// TODO: Remove this fallback once goose2 has first-class /-commands.
const MANUAL_COMPACT_TRIGGER = "/compact";
const EMPTY_MESSAGES: Message[] = [];
type CompactConversationResult = "completed" | "failed" | "skipped";
type EnsurePrepared = (personaId?: string) => Promise<boolean | undefined>;

function createCompactionConfirmationMessage() {
  return createSystemNotificationMessage(
    i18n.t("chat:notifications.compactionComplete"),
    "compaction",
  );
}

async function ensurePreparedForPrompt(
  ensurePrepared: EnsurePrepared | undefined,
  personaId?: string,
) {
  const prepared = await ensurePrepared?.(personaId);
  if (prepared === false) {
    throw new Error(i18n.t("chat:errors.sessionPreparationSuperseded"));
  }
}

function markMessageStopped(sessionId: string, messageId: string) {
  useChatStore.getState().updateMessage(sessionId, messageId, (message) => {
    if (
      message.metadata?.completionStatus === "completed" ||
      message.metadata?.completionStatus === "error" ||
      message.metadata?.completionStatus === "stopped"
    ) {
      return message;
    }

    return {
      ...message,
      metadata: {
        ...message.metadata,
        completionStatus: "stopped",
      },
      content: message.content.map((block) =>
        block.type === "toolRequest" && block.status === "in_progress"
          ? { ...block, status: "stopped" }
          : block,
      ),
    };
  });
}

function formatSteerErrorMessage(error: unknown): string {
  const message = formatAcpErrorMessage(error);
  return message.toLowerCase().includes("method not found")
    ? i18n.t("chat:errors.steeringBackendUnavailable")
    : message;
}

/**
 * Hook for managing a chat session -- sending messages, handling streaming,
 * and managing chat lifecycle.
 */
export function useChat(
  sessionId: string,
  providerOverride?: string,
  systemPromptOverride?: string,
  personaInfo?: { id: string; name: string },
  options?: {
    onMessageAccepted?: (sessionId: string) => void;
    ensurePrepared?: EnsurePrepared;
  },
) {
  const abortRef = useRef<AbortController | null>(null);

  const messages = useChatStore(
    (s) => s.messagesBySession[sessionId] ?? EMPTY_MESSAGES,
  );
  const runtime = useChatStore(
    (s) => s.sessionStateById[sessionId] ?? INITIAL_SESSION_CHAT_RUNTIME,
  );
  const setActiveSession = useChatStore((s) => s.setActiveSession);
  const addMessage = useChatStore((s) => s.addMessage);
  const setMessages = useChatStore((s) => s.setMessages);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const setChatState = useChatStore((s) => s.setChatState);
  const setError = useChatStore((s) => s.setError);
  const setStreamingMessageId = useChatStore((s) => s.setStreamingMessageId);
  const setPendingAssistantProvider = useChatStore(
    (s) => s.setPendingAssistantProvider,
  );
  const clearDraft = useChatStore((s) => s.clearDraft);
  const setSessionLoading = useChatStore((s) => s.setSessionLoading);

  const { chatState, tokenState, error, streamingMessageId } = runtime;
  const isStreaming = chatState === "streaming" || streamingMessageId !== null;

  const resolvePersonaInfo = useCallback(
    (overridePersonaId?: string, overridePersonaName?: string) => {
      if (overridePersonaId) {
        // Read the latest persona snapshot at call time so override lookups
        // still work even if the agent store changed after this hook rendered.
        const personaName =
          overridePersonaName ??
          useAgentStore.getState().getPersonaById(overridePersonaId)
            ?.displayName ??
          overridePersonaId;
        return { id: overridePersonaId, name: personaName };
      }

      return personaInfo;
    },
    [personaInfo],
  );

  const sendMessage = useCallback(
    async (
      text: string,
      overridePersona?: { id: string; name?: string },
      attachments?: ChatAttachmentDraft[],
      sendOptions?: ChatSendOptions,
    ) => {
      const sid = sessionId.slice(0, 8);
      const hasAttachments = (attachments?.length ?? 0) > 0;
      const hasAssistantPrompt = Boolean(sendOptions?.assistantPrompt?.trim());
      const currentChatState = useChatStore
        .getState()
        .getSessionRuntime(sessionId).chatState;
      if (
        (!text.trim() && !hasAttachments && !hasAssistantPrompt) ||
        currentChatState === "streaming" ||
        currentChatState === "thinking" ||
        currentChatState === "compacting"
      )
        return;
      perfLog(
        `[perf:send] ${sid} useChat.sendMessage start (textLen=${text.length}, attachments=${attachments?.length ?? 0})`,
      );

      const effectivePersonaInfo = resolvePersonaInfo(
        overridePersona?.id,
        overridePersona?.name,
      );
      const agent = useAgentStore.getState().getActiveAgent();
      const providerId = providerOverride ?? agent?.provider ?? "goose";
      const systemPrompt = systemPromptOverride ?? agent?.systemPrompt;

      // Ensure active session
      setActiveSession(sessionId);

      const abort = new AbortController();
      abortRef.current = abort;

      try {
        await dispatchPrompt(sessionId, text, {
          persona: effectivePersonaInfo,
          attachments,
          assistantPrompt: sendOptions?.assistantPrompt,
          displayText: sendOptions?.displayText,
          chips: sendOptions?.chips,
          providerId,
          systemPrompt,
          prepare: () =>
            ensurePreparedForPrompt(
              options?.ensurePrepared,
              effectivePersonaInfo?.id,
            ),
          onUserMessageCommitted: () => {
            options?.onMessageAccepted?.(sessionId);
            clearDraft(sessionId);
          },
        });
      } catch {
        // dispatchPrompt already recorded the failure in the chat stores; for
        // an AbortError it only returns the session to idle. sendMessage's
        // contract is to never reject.
      } finally {
        abortRef.current = null;
      }
    },
    [
      sessionId,
      setActiveSession,
      clearDraft,
      providerOverride,
      systemPromptOverride,
      resolvePersonaInfo,
      options,
    ],
  );

  const steerMessage = useCallback(
    async (
      text: string,
      attachments?: ChatAttachmentDraft[],
      sendOptions?: ChatSendOptions,
    ) => {
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
      const acpPrompt =
        promptWithPaths || (images?.length ? " " : promptWithPaths);
      addMessage(sessionId, userMessage);
      useChatStore.getState().setPendingInterventionBoundary(sessionId, {
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
        const chatStore = useChatStore.getState();
        chatStore.removeMessage(sessionId, userMessage.id);
        if (
          chatStore.getSessionRuntime(sessionId).pendingInterventionBoundary
            ?.interventionMessageId === userMessage.id
        ) {
          chatStore.setPendingInterventionBoundary(sessionId, null);
        }
        const errorMessage = formatSteerErrorMessage(err);
        chatStore.addMessage(
          sessionId,
          createSystemNotificationMessage(errorMessage, "error"),
        );
        return false;
      }
    },
    [addMessage, sessionId],
  );

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    const runtime = useChatStore.getState().getSessionRuntime(sessionId);
    const activeStreamingMessageId = runtime.streamingMessageId;

    setChatState(sessionId, "idle");
    setStreamingMessageId(sessionId, null);
    useChatStore.getState().setActiveRunId(sessionId, null);
    setPendingAssistantProvider(sessionId, null);
    // Cancel the backend ACP session to stop orphaned streaming/tool events. We
    // send cancellation even while still "thinking" before ACP has created a
    // visible assistant message; that is exactly when users need interruption
    // most for long-running tool calls.
    const cancellation = acpCancelSession(sessionId)
      .then((wasCancelled) => {
        if (wasCancelled && activeStreamingMessageId) {
          markMessageStopped(sessionId, activeStreamingMessageId);
        }
        return wasCancelled;
      })
      .catch(() => false);

    return cancellation;
  }, [
    setChatState,
    setPendingAssistantProvider,
    setStreamingMessageId,
    sessionId,
  ]);

  const clearChat = useCallback(() => {
    abortRef.current?.abort();
    clearMessages(sessionId);
    resetPersonaHandoff(sessionId);
    setChatState(sessionId, "idle");
    setStreamingMessageId(sessionId, null);
    useChatStore.getState().setActiveRunId(sessionId, null);
    setPendingAssistantProvider(sessionId, null);
  }, [
    sessionId,
    clearMessages,
    setChatState,
    setStreamingMessageId,
    setPendingAssistantProvider,
  ]);

  const getWorkingDir = useCallback(() => {
    const sessionStore = useChatSessionStore.getState();
    return (
      sessionStore.activeWorkspaceBySession[sessionId]?.path ??
      sessionStore.getSession(sessionId)?.workingDir
    );
  }, [sessionId]);

  const compactConversation = useCallback(
    async (overridePersona?: { id: string; name?: string }) => {
      const currentChatState = useChatStore
        .getState()
        .getSessionRuntime(sessionId).chatState;
      if (currentChatState !== "idle") {
        return "skipped" as CompactConversationResult;
      }

      const effectivePersonaInfo = resolvePersonaInfo(
        overridePersona?.id,
        overridePersona?.name,
      );

      setActiveSession(sessionId);
      setChatState(sessionId, "compacting");
      setStreamingMessageId(sessionId, null);
      setError(sessionId, null);

      try {
        await ensurePreparedForPrompt(
          options?.ensurePrepared,
          effectivePersonaInfo?.id,
        );
      } catch (err) {
        const errorMessage = formatAcpErrorMessage(err);
        addMessage(
          sessionId,
          createSystemNotificationMessage(errorMessage, "error"),
        );
        setError(sessionId, errorMessage);
        setChatState(sessionId, "idle");
        return "failed" as CompactConversationResult;
      }

      setSessionLoading(sessionId, true);
      clearReplayBuffer(sessionId);

      try {
        const sendOptions = effectivePersonaInfo?.id
          ? { personaId: effectivePersonaInfo.id }
          : undefined;
        await acpSendMessage(sessionId, MANUAL_COMPACT_TRIGGER, sendOptions);

        // Command responses are streamed via prompt notifications, but the ACP
        // layer does not currently forward history replacement events. Drop those
        // transient chunks and refresh the session from replay instead.
        clearReplayBuffer(sessionId);
        const workingDir = getWorkingDir();
        await acpLoadSession(sessionId, workingDir);

        setSessionLoading(sessionId, false);

        const buffer = getAndDeleteReplayBuffer(sessionId);
        if (buffer) {
          setMessages(sessionId, [
            ...sanitizeReplayMessages(buffer),
            createCompactionConfirmationMessage(),
          ]);
        } else {
          addMessage(sessionId, createCompactionConfirmationMessage());
        }
        return "completed" as CompactConversationResult;
      } catch (err) {
        clearReplayBuffer(sessionId);
        setSessionLoading(sessionId, false);

        const errorMessage = formatAcpErrorMessage(err);
        addMessage(
          sessionId,
          createSystemNotificationMessage(errorMessage, "error"),
        );
        setError(sessionId, errorMessage);
        return "failed" as CompactConversationResult;
      } finally {
        setChatState(sessionId, "idle");
        setStreamingMessageId(sessionId, null);
        setPendingAssistantProvider(sessionId, null);
        setSessionLoading(sessionId, false);
      }
    },
    [
      getWorkingDir,
      options,
      resolvePersonaInfo,
      sessionId,
      setActiveSession,
      setChatState,
      setStreamingMessageId,
      setError,
      addMessage,
      setSessionLoading,
      setMessages,
      setPendingAssistantProvider,
    ],
  );

  const stopStreaming = stopGeneration;

  return {
    messages,
    chatState: chatState as ChatState,
    tokenState: tokenState as TokenState,
    error,
    streamingMessageId,
    activeRunId: runtime.activeRunId,
    sendMessage,
    steerMessage,
    stopGeneration,
    stopStreaming,
    clearChat,
    compactConversation,
    isStreaming,
  };
}
