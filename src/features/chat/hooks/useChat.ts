import { useCallback, useRef } from "react";
import { useChatStore } from "../stores/chatStore";
import { useChatSessionStore } from "../stores/chatSessionStore";
import { clearReplayBuffer } from "./replayBuffer";
import {
  type ChatAttachmentDraft,
  type Message,
  createSystemNotificationMessage,
} from "@/shared/types/messages";
import type { ChatState, TokenState } from "@/shared/types/chat";
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";
import {
  acpSendMessage,
  acpCancelSession,
  acpLoadSession,
} from "@/shared/api/acp";
import { resetPersonaHandoff } from "@/shared/api/acpPersonaHandoff";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import {
  dispatchPrompt,
  registerAssistantCancellationTarget,
  resolveAssistantCancellation,
} from "../lib/sendCore";
import { perfLog } from "@/shared/lib/perfLog";
import { replaceMessagesFromSessionReplay } from "../lib/sessionReplayReplacement";
import { i18n } from "@/shared/i18n";
import type { ChatSendOptions } from "../types";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { steerPromptInSession } from "../lib/steerCore";
import {
  clearBufferedStreamingUpdatesForSession,
  flushBufferedStreamingUpdatesForSession,
} from "../acp/liveStreamingUpdates";
import { useWorkspaceRepository } from "@/features/workspaces/workspaceRepository";
import { isRemoteSession } from "../lib/remoteSession";

// TODO: Remove this fallback once goose2 has first-class /-commands.
const MANUAL_COMPACT_TRIGGER = "/compact";
const EMPTY_MESSAGES: Message[] = [];
const cancellationOwnerBySession = new Map<string, symbol>();
const cancellationPromiseBySession = new Map<string, Promise<boolean>>();
type CompactConversationResult =
  | "completed"
  | "completed-with-refresh-warning"
  | "failed"
  | "skipped";
type EnsurePrepared = (
  personaId?: string,
  sessionSelection?: ChatSendOptions["sessionSelection"],
  sessionSelectionToken?: ChatSendOptions["sessionSelectionToken"],
) => Promise<boolean | undefined>;

function createCompactionConfirmationMessage() {
  return createSystemNotificationMessage(
    i18n.t("chat:notifications.compactionComplete"),
    "compaction",
  );
}

async function ensurePreparedForPrompt(
  ensurePrepared: EnsurePrepared | undefined,
  personaId?: string,
  sessionSelection?: ChatSendOptions["sessionSelection"],
  sessionSelectionToken?: ChatSendOptions["sessionSelectionToken"],
) {
  const prepared = sessionSelection
    ? await ensurePrepared?.(personaId, sessionSelection, sessionSelectionToken)
    : await ensurePrepared?.(personaId);
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
    onMessageAccepted?: (
      sessionId: string,
      text: string,
    ) => boolean | undefined;
    ensurePrepared?: EnsurePrepared;
  },
) {
  const abortRef = useRef<AbortController | null>(null);
  const workspaceRepository = useWorkspaceRepository();

  const messages = useChatStore(
    (s) => s.messagesBySession[sessionId] ?? EMPTY_MESSAGES,
  );
  const runtime = useChatStore(
    (s) => s.sessionStateById[sessionId] ?? INITIAL_SESSION_CHAT_RUNTIME,
  );
  const addMessage = useChatStore((s) => s.addMessage);
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
    (overridePersonaId?: string | null, overridePersonaName?: string) => {
      if (overridePersonaId === null) {
        return undefined;
      }
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
      overridePersona?: { id: string | null; name?: string },
      attachments?: ChatAttachmentDraft[],
      sendOptions?: ChatSendOptions,
    ) => {
      const sid = sessionId.slice(0, 8);
      const hasAttachments = (attachments?.length ?? 0) > 0;
      const hasAssistantPrompt = Boolean(sendOptions?.assistantPrompt?.trim());
      const currentChatState = useChatStore
        .getState()
        .getSessionRuntime(sessionId).chatState;
      const isRunCancellationPending = useChatStore
        .getState()
        .getSessionRuntime(sessionId).isRunCancellationPending;
      if (
        (!text.trim() && !hasAttachments && !hasAssistantPrompt) ||
        isRunCancellationPending ||
        currentChatState === "streaming" ||
        currentChatState === "thinking" ||
        currentChatState === "compacting"
      )
        return false;
      perfLog(
        `[perf:send] ${sid} useChat.sendMessage start (textLen=${text.length}, attachments=${attachments?.length ?? 0})`,
      );

      const effectivePersonaInfo = resolvePersonaInfo(
        overridePersona?.id,
        overridePersona?.name,
      );
      const agent = useAgentStore.getState().getActiveAgent();
      const providerId = providerOverride ?? agent?.provider ?? "goose";
      const systemPrompt =
        sendOptions?.executionSystemPrompt ??
        systemPromptOverride ??
        agent?.systemPrompt;

      const abort = new AbortController();
      abortRef.current = abort;

      let accepted = false;
      let userMessageCommitted = false;
      const acceptedPromise = new Promise<boolean>((resolve) => {
        void dispatchPrompt(sessionId, text, {
          persona: effectivePersonaInfo,
          attachments,
          assistantPrompt: sendOptions?.assistantPrompt,
          displayText: sendOptions?.displayText,
          userMessageId: sendOptions?.userMessageId,
          chips: sendOptions?.chips,
          userMessageMetadata: sendOptions?.userMessageMetadata,
          acpGooseMetadata: sendOptions?.acpGooseMetadata,
          providerId,
          systemPrompt,
          beforeUserMessageCommitted: sendOptions?.beforeUserMessageCommitted,
          signal: abort.signal,
          prepare: () =>
            ensurePreparedForPrompt(
              options?.ensurePrepared,
              effectivePersonaInfo?.id,
              sendOptions?.sessionSelection,
              sendOptions?.sessionSelectionToken,
            ),
          onUserMessageCommitted: () => {
            userMessageCommitted = true;
            sendOptions?.onUserMessageCommitted?.();
            const shouldClearDraft =
              options?.onMessageAccepted?.(sessionId, text) !== false;
            if (shouldClearDraft) {
              clearDraft(sessionId);
            }
          },
          onPromptDispatched: () => {
            accepted = true;
            // Queue ownership ends once preparation succeeds and the ACP
            // prompt invocation starts. Later run failure cannot retry a turn
            // that has already crossed the transport boundary.
            resolve(true);
          },
        })
          .catch(() => {
            // dispatchPrompt records the failure in the chat stores. A failure
            // before commitment is a rejection; a later run failure does not
            // make the already-committed user turn retryable.
            if (!accepted) {
              resolve(userMessageCommitted);
            }
          })
          .finally(() => {
            if (abortRef.current === abort) {
              abortRef.current = null;
            }
          });
      });
      return acceptedPromise;
    },
    [
      sessionId,
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
      return steerPromptInSession(sessionId, text, attachments, sendOptions);
    },
    [sessionId],
  );

  const stopGeneration = useCallback(() => {
    const chatStore = useChatStore.getState();
    const runtime = chatStore.getSessionRuntime(sessionId);
    const pendingCancellation = cancellationPromiseBySession.get(sessionId);
    if (runtime.isRunCancellationPending && pendingCancellation) {
      return pendingCancellation;
    }

    abortRef.current?.abort();
    const activeStreamingMessageId = runtime.streamingMessageId;
    const shouldClearPendingAfterCancel =
      runtime.chatState === "thinking" && runtime.activeRunId === null;
    const cancellationOwner = Symbol(sessionId);
    cancellationOwnerBySession.set(sessionId, cancellationOwner);
    const ownsCancellation = () =>
      cancellationOwnerBySession.get(sessionId) === cancellationOwner;
    const ownsPendingCancellation = () =>
      ownsCancellation() &&
      useChatStore.getState().getSessionRuntime(sessionId)
        .isRunCancellationPending;
    const clearPendingIfNoActiveRun = () => {
      if (!ownsPendingCancellation()) return;
      const latestStore = useChatStore.getState();
      const latestRuntime = latestStore.getSessionRuntime(sessionId);
      if (
        latestRuntime.isRunCancellationPending &&
        latestRuntime.activeRunId === null
      ) {
        latestStore.settleActiveRun(sessionId);
      }
    };

    chatStore.setRunCancellationPending(sessionId, true);
    const cancelledPromptOwner = activeStreamingMessageId
      ? registerAssistantCancellationTarget(sessionId, activeStreamingMessageId)
      : null;
    flushBufferedStreamingUpdatesForSession(sessionId, { flushSubtitle: true });
    setChatState(sessionId, "idle");
    setPendingAssistantProvider(sessionId, null);
    // Cancel the backend ACP session to stop orphaned streaming/tool events. We
    // send cancellation even while still "thinking" before ACP has created a
    // visible assistant message; that is exactly when users need interruption
    // most for long-running tool calls.
    const cancellation = acpCancelSession(sessionId)
      .then((wasCancelled) => {
        if (!ownsCancellation()) return wasCancelled;
        if (activeStreamingMessageId) {
          if (wasCancelled) {
            markMessageStopped(sessionId, activeStreamingMessageId);
          }
          resolveAssistantCancellation(cancelledPromptOwner, wasCancelled);
        }
        if (
          ownsPendingCancellation() &&
          (!wasCancelled || shouldClearPendingAfterCancel)
        ) {
          clearPendingIfNoActiveRun();
        }
        return wasCancelled;
      })
      .catch((err) => {
        if (!ownsCancellation()) return false;
        if (activeStreamingMessageId) {
          resolveAssistantCancellation(cancelledPromptOwner, false);
        }
        if (!ownsPendingCancellation()) return false;
        const errorMessage = formatAcpErrorMessage(err);
        const latestStore = useChatStore.getState();
        latestStore.addMessage(
          sessionId,
          createSystemNotificationMessage(errorMessage, "error"),
        );
        latestStore.setError(sessionId, errorMessage);
        clearPendingIfNoActiveRun();
        return false;
      })
      .finally(() => {
        if (cancellationOwnerBySession.get(sessionId) === cancellationOwner) {
          cancellationOwnerBySession.delete(sessionId);
          cancellationPromiseBySession.delete(sessionId);
        }
      });

    cancellationPromiseBySession.set(sessionId, cancellation);
    return cancellation;
  }, [setChatState, setPendingAssistantProvider, sessionId]);

  const clearChat = useCallback(() => {
    abortRef.current?.abort();
    clearBufferedStreamingUpdatesForSession(sessionId);
    clearMessages(sessionId);
    resetPersonaHandoff(sessionId);
    useChatStore.getState().setRunCancellationPending(sessionId, false);
    setChatState(sessionId, "idle");
    useChatStore.getState().setActiveRunId(sessionId, null);
    setPendingAssistantProvider(sessionId, null);
  }, [sessionId, clearMessages, setChatState, setPendingAssistantProvider]);

  const getWorkingDir = useCallback(() => {
    const sessionStore = useChatSessionStore.getState();
    const session = sessionStore.getSession(sessionId);
    if (isRemoteSession(session)) {
      // Remote paths must pass through verbatim: the local workspace
      // repository can only resolve directories on this machine.
      return session?.workingDir ?? undefined;
    }
    return workspaceRepository.chatWorkspaces(session, {
      activePath: sessionStore.activeWorkspaceBySession[sessionId]?.path,
    }).primary?.path;
  }, [sessionId, workspaceRepository]);

  const compactConversation = useCallback(
    async (
      overridePersona?: { id: string | null; name?: string },
      dispatch?: Pick<
        ChatSendOptions,
        "sessionSelection" | "sessionSelectionToken"
      >,
    ) => {
      const currentRuntime = useChatStore
        .getState()
        .getSessionRuntime(sessionId);
      if (
        currentRuntime.chatState !== "idle" ||
        currentRuntime.activeRunId !== null ||
        currentRuntime.isRunCancellationPending
      ) {
        return "skipped" as CompactConversationResult;
      }

      const effectivePersonaInfo = resolvePersonaInfo(
        overridePersona?.id,
        overridePersona?.name,
      );

      flushBufferedStreamingUpdatesForSession(sessionId, {
        flushSubtitle: true,
      });
      setChatState(sessionId, "compacting");
      setStreamingMessageId(sessionId, null);
      setError(sessionId, null);

      try {
        await ensurePreparedForPrompt(
          options?.ensurePrepared,
          effectivePersonaInfo?.id,
          dispatch?.sessionSelection,
          dispatch?.sessionSelectionToken,
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

      let compactionCommitted = false;
      try {
        const sendOptions = effectivePersonaInfo?.id
          ? { personaId: effectivePersonaInfo.id }
          : undefined;
        await acpSendMessage(sessionId, MANUAL_COMPACT_TRIGGER, sendOptions);
        compactionCommitted = true;

        // Command responses are streamed via prompt notifications, but the ACP
        // layer does not currently forward history replacement events. Drop those
        // transient chunks and refresh the session from replay instead.
        clearBufferedStreamingUpdatesForSession(sessionId);
        clearReplayBuffer(sessionId);
        const workingDir = getWorkingDir();
        await acpLoadSession(sessionId, workingDir ?? undefined);

        setSessionLoading(sessionId, false);

        const replayResult = replaceMessagesFromSessionReplay(sessionId, {
          historyExpectation: "nonempty",
          trailingMessages: [createCompactionConfirmationMessage()],
        });
        if (replayResult.status === "invalid") {
          const errorMessage = i18n.t(
            "chat:notifications.compactionReplayIncomplete",
          );
          addMessage(
            sessionId,
            createSystemNotificationMessage(errorMessage, "error"),
          );
          return "completed-with-refresh-warning" as CompactConversationResult;
        }
        return "completed" as CompactConversationResult;
      } catch (err) {
        clearReplayBuffer(sessionId);
        setSessionLoading(sessionId, false);

        if (compactionCommitted) {
          const errorMessage = i18n.t(
            "chat:notifications.compactionReplayIncomplete",
          );
          addMessage(
            sessionId,
            createSystemNotificationMessage(errorMessage, "error"),
          );
          return "completed-with-refresh-warning" as CompactConversationResult;
        }

        const errorMessage = formatAcpErrorMessage(err);
        addMessage(
          sessionId,
          createSystemNotificationMessage(errorMessage, "error"),
        );
        setError(sessionId, errorMessage);
        return "failed" as CompactConversationResult;
      } finally {
        clearBufferedStreamingUpdatesForSession(sessionId);
        setChatState(sessionId, "idle");
        setPendingAssistantProvider(sessionId, null);
        setSessionLoading(sessionId, false);
      }
    },
    [
      getWorkingDir,
      options,
      resolvePersonaInfo,
      sessionId,
      setChatState,
      setStreamingMessageId,
      setError,
      addMessage,
      setSessionLoading,
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
    isRunCancellationPending: runtime.isRunCancellationPending,
    sendMessage,
    steerMessage,
    stopGeneration,
    stopStreaming,
    clearChat,
    compactConversation,
    isStreaming,
  };
}
