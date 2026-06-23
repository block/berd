import { create, type StateCreator } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type {
  ChatAttachmentDraft,
  Message,
  MessageContent,
} from "@/shared/types/messages";
import { clearReplayBuffer } from "../hooks/replayBuffer";
import type {
  ChatState,
  SessionChatRuntime,
  TokenState,
} from "@/shared/types/chat";
import {
  INITIAL_SESSION_CHAT_RUNTIME,
  INITIAL_TOKEN_STATE,
} from "@/shared/types/chat";
import type { ChatSendOptions, ChatSkillDraft } from "../types";
import { loadCachedDrafts, persistDrafts } from "./draftPersistence";
import {
  loadCachedUnreadSessionIds,
  persistUnreadSessionIds,
} from "./unreadPersistence";

const MESSAGE_SESSION_CACHE_LIMIT = 10;

function createInitialSessionRuntime(): SessionChatRuntime {
  return {
    ...INITIAL_SESSION_CHAT_RUNTIME,
    tokenState: { ...INITIAL_TOKEN_STATE },
  };
}

function isSessionActivelyViewed(
  state: ChatStoreState,
  sessionId: string,
): boolean {
  return state.activeSessionId === sessionId && state.isViewingActiveSession;
}

function canEvictSessionMessages(
  state: ChatStoreState,
  sessionId: string,
): boolean {
  if (state.loadingSessionIds.has(sessionId)) return false;

  const runtime = state.sessionStateById[sessionId];
  if (!runtime) return true;

  return (
    runtime.chatState === "idle" &&
    runtime.activeRunId === null &&
    runtime.streamingMessageId === null &&
    !runtime.isRunCancellationPending
  );
}

function updateRecentMessageSessionIds(
  recentSessionIds: string[] | undefined,
  sessionId: string,
): string[] {
  return [
    sessionId,
    ...(recentSessionIds ?? []).filter((id) => id !== sessionId),
  ].slice(0, MESSAGE_SESSION_CACHE_LIMIT);
}

function removeRecentMessageSessionId(
  recentSessionIds: string[] | undefined,
  sessionId: string,
): string[] {
  return (recentSessionIds ?? []).filter((id) => id !== sessionId);
}

function replaceRecentMessageSessionId(
  recentSessionIds: string[] | undefined,
  fromSessionId: string,
  toSessionId: string,
): string[] {
  return Array.from(
    new Set(
      (recentSessionIds ?? []).map((id) =>
        id === fromSessionId ? toSessionId : id,
      ),
    ),
  ).slice(0, MESSAGE_SESSION_CACHE_LIMIT);
}

function trimMessageSessionCache(
  state: ChatStoreState,
  recentMessageSessionIds: string[],
  additionalProtectedSessionIds: string[] = [],
): {
  messagesBySession: Record<string, Message[]>;
  evictedSessionIds: string[];
} {
  const protectedSessionIds = new Set([
    ...recentMessageSessionIds,
    ...additionalProtectedSessionIds,
  ]);
  const evictedSessionIds: string[] = [];
  let cachedSessionCount = Object.keys(state.messagesBySession).length;
  let messagesBySession = state.messagesBySession;

  if (cachedSessionCount <= MESSAGE_SESSION_CACHE_LIMIT) {
    return { messagesBySession, evictedSessionIds };
  }

  for (const sessionId of Object.keys(state.messagesBySession)) {
    if (cachedSessionCount <= MESSAGE_SESSION_CACHE_LIMIT) break;
    if (
      protectedSessionIds.has(sessionId) ||
      !canEvictSessionMessages(state, sessionId)
    ) {
      continue;
    }

    if (messagesBySession === state.messagesBySession) {
      messagesBySession = { ...state.messagesBySession };
    }
    delete messagesBySession[sessionId];
    evictedSessionIds.push(sessionId);
    cachedSessionCount -= 1;
  }

  return { messagesBySession, evictedSessionIds };
}

function shouldMarkSessionUnread(
  state: ChatStoreState,
  sessionId: string,
  message: Message,
): boolean {
  return (
    message.role === "assistant" &&
    message.metadata?.userVisible !== false &&
    !isSessionActivelyViewed(state, sessionId)
  );
}

function buildInitialSessionStateById(): Record<string, SessionChatRuntime> {
  return Object.fromEntries(
    loadCachedUnreadSessionIds().map((sessionId) => [
      sessionId,
      {
        ...createInitialSessionRuntime(),
        hasUnread: true,
      },
    ]),
  );
}

function getUnreadSessionIds(
  sessionStateById: Record<string, SessionChatRuntime>,
): string[] {
  return Object.entries(sessionStateById)
    .filter(([, runtime]) => runtime.hasUnread)
    .map(([sessionId]) => sessionId);
}

function areSessionIdListsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const bIds = new Set(b);
  return a.every((id) => bIds.has(id));
}

function persistUnreadStateIfChanged(
  previousSessionStateById: Record<string, SessionChatRuntime>,
  nextSessionStateById: Record<string, SessionChatRuntime>,
): void {
  const previousUnreadIds = getUnreadSessionIds(previousSessionStateById);
  const nextUnreadIds = getUnreadSessionIds(nextSessionStateById);
  if (areSessionIdListsEqual(previousUnreadIds, nextUnreadIds)) return;
  persistUnreadSessionIds(nextUnreadIds);
}

function createAssistantContinuationMessage(
  previousMessage?: Message,
): Message {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    created: Date.now(),
    content: [],
    metadata: {
      userVisible: true,
      agentVisible: true,
      completionStatus: "inProgress",
      ...(previousMessage?.metadata?.personaId
        ? { personaId: previousMessage.metadata.personaId }
        : {}),
      ...(previousMessage?.metadata?.personaName
        ? { personaName: previousMessage.metadata.personaName }
        : {}),
      ...(previousMessage?.metadata?.providerId
        ? { providerId: previousMessage.metadata.providerId }
        : {}),
    },
  };
}

function insertMessageAfter(
  messages: Message[],
  afterMessageId: string,
  message: Message,
): Message[] {
  const index = messages.findIndex((item) => item.id === afterMessageId);
  if (index === -1) {
    return [...messages, message];
  }

  return [
    ...messages.slice(0, index + 1),
    message,
    ...messages.slice(index + 1),
  ];
}

function findLatestInterventionMessageId(messages: Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && message.metadata?.delivery === "steer") {
      return message.id;
    }
  }
  return null;
}

export interface QueuedMessage {
  text: string;
  personaId?: string;
  attachments?: ChatAttachmentDraft[];
  sendOptions?: ChatSendOptions;
}

export interface ScrollTargetMessage {
  messageId: string;
  query?: string;
}

interface ChatStoreState {
  messagesBySession: Record<string, Message[]>;
  sessionStateById: Record<string, SessionChatRuntime>;
  queuedMessageBySession: Record<string, QueuedMessage>;
  draftsBySession: Record<string, string>;
  skillDraftsBySession: Record<string, ChatSkillDraft[]>;
  activeSessionId: string | null;
  recentMessageSessionIds: string[];
  isViewingActiveSession: boolean;
  isConnected: boolean;
  loadingSessionIds: Set<string>;
  scrollTargetMessageBySession: Record<string, ScrollTargetMessage | null>;
}

interface ChatStoreActions {
  setActiveSession: (sessionId: string) => void;
  setActiveSessionViewing: (isViewing: boolean) => void;
  addMessage: (sessionId: string, message: Message) => void;
  updateMessage: (
    sessionId: string,
    messageId: string,
    updater: (msg: Message) => Message,
  ) => void;
  removeMessage: (sessionId: string, messageId: string) => void;
  setMessages: (sessionId: string, messages: Message[]) => void;
  clearMessages: (sessionId: string) => void;
  getActiveMessages: () => Message[];
  getSessionRuntime: (sessionId: string) => SessionChatRuntime;
  setStreamingMessageId: (sessionId: string, id: string | null) => void;
  setActiveRunId: (sessionId: string, runId: string | null) => void;
  setRunCancellationPending: (sessionId: string, pending: boolean) => void;
  setPendingInterventionBoundary: (
    sessionId: string,
    boundary: SessionChatRuntime["pendingInterventionBoundary"],
  ) => void;
  setPendingAssistantProvider: (
    sessionId: string,
    providerId: string | null,
  ) => void;
  appendToStreamingMessage: (
    sessionId: string,
    content: MessageContent,
  ) => void;
  appendStreamingText: (
    sessionId: string,
    messageId: string,
    text: string,
  ) => void;
  updateStreamingText: (sessionId: string, text: string) => void;
  startAssistantStreamAfterIntervention: (sessionId: string) => void;
  setChatState: (sessionId: string, state: ChatState) => void;
  setError: (sessionId: string, error: string | null) => void;
  setConnected: (connected: boolean) => void;
  markSessionRead: (sessionId: string) => void;
  markSessionUnread: (sessionId: string) => void;
  updateTokenState: (sessionId: string, state: Partial<TokenState>) => void;
  replaceTokenState: (
    sessionId: string,
    tokenState: TokenState,
    hasUsageSnapshot?: boolean,
  ) => void;
  resetTokenState: (sessionId: string) => void;
  enqueueMessage: (sessionId: string, message: QueuedMessage) => void;
  dismissQueuedMessage: (sessionId: string) => void;
  setDraft: (sessionId: string, text: string) => void;
  clearDraft: (sessionId: string) => void;
  setSkillDrafts: (sessionId: string, skills: ChatSkillDraft[]) => void;
  clearSkillDrafts: (sessionId: string) => void;
  setSessionLoading: (sessionId: string, loading: boolean) => void;
  setScrollTargetMessage: (
    sessionId: string,
    messageId: string,
    query?: string,
  ) => void;
  clearScrollTargetMessage: (sessionId: string) => void;
  promoteSessionId: (draftSessionId: string, backendSessionId: string) => void;
  cleanupSession: (sessionId: string) => void;
}

export type ChatStore = ChatStoreState & ChatStoreActions;

const createChatStore: StateCreator<
  ChatStore,
  [["zustand/subscribeWithSelector", never]]
> = (set, get) => ({
  // State
  messagesBySession: {},
  sessionStateById: buildInitialSessionStateById(),
  queuedMessageBySession: {},
  draftsBySession: loadCachedDrafts(),
  skillDraftsBySession: {},
  activeSessionId: null,
  recentMessageSessionIds: [],
  isViewingActiveSession: false,
  isConnected: false,
  loadingSessionIds: new Set<string>(),
  scrollTargetMessageBySession: {},

  // Session management
  setActiveSession: (sessionId) => {
    let evictedSessionIds: string[] = [];
    set((state) => {
      const recentMessageSessionIds = updateRecentMessageSessionIds(
        state.recentMessageSessionIds,
        sessionId,
      );
      const trimmedCache = trimMessageSessionCache(
        state,
        recentMessageSessionIds,
      );
      evictedSessionIds = trimmedCache.evictedSessionIds;

      return {
        activeSessionId: sessionId,
        recentMessageSessionIds,
        messagesBySession: trimmedCache.messagesBySession,
        sessionStateById: state.sessionStateById[sessionId]
          ? state.sessionStateById
          : {
              ...state.sessionStateById,
              [sessionId]: createInitialSessionRuntime(),
            },
      };
    });
    evictedSessionIds.forEach(clearReplayBuffer);
  },

  setActiveSessionViewing: (isViewingActiveSession) =>
    set({ isViewingActiveSession }),

  // Message management
  addMessage: (sessionId, message) => {
    const previousSessionStateById = get().sessionStateById;
    let evictedSessionIds: string[] = [];
    set((state) => {
      const current =
        state.sessionStateById[sessionId] ?? createInitialSessionRuntime();
      const shouldMarkUnread = shouldMarkSessionUnread(
        state,
        sessionId,
        message,
      );
      const recentMessageSessionIds =
        state.activeSessionId === sessionId
          ? updateRecentMessageSessionIds(
              state.recentMessageSessionIds,
              sessionId,
            )
          : state.recentMessageSessionIds;
      const nextMessagesBySession = {
        ...state.messagesBySession,
        [sessionId]: [...(state.messagesBySession[sessionId] ?? []), message],
      };
      const trimmedCache = trimMessageSessionCache(
        { ...state, messagesBySession: nextMessagesBySession },
        recentMessageSessionIds,
        [sessionId],
      );
      evictedSessionIds = trimmedCache.evictedSessionIds;

      return {
        messagesBySession: trimmedCache.messagesBySession,
        recentMessageSessionIds,
        ...(shouldMarkUnread
          ? {
              sessionStateById: {
                ...state.sessionStateById,
                [sessionId]: {
                  ...current,
                  hasUnread: true,
                },
              },
            }
          : {}),
      };
    });
    evictedSessionIds.forEach(clearReplayBuffer);
    persistUnreadStateIfChanged(
      previousSessionStateById,
      get().sessionStateById,
    );
  },

  updateMessage: (sessionId, messageId, updater) => {
    const previousSessionStateById = get().sessionStateById;
    set((state) => {
      const messages = state.messagesBySession[sessionId];
      if (!messages) return state;

      let shouldMarkUnread = false;
      const updatedMessages = messages.map((message) => {
        if (message.id !== messageId) return message;

        const updated = updater(message);
        shouldMarkUnread =
          updated !== message &&
          shouldMarkSessionUnread(state, sessionId, updated);
        return updated;
      });

      const current =
        state.sessionStateById[sessionId] ?? createInitialSessionRuntime();

      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: updatedMessages,
        },
        ...(shouldMarkUnread
          ? {
              sessionStateById: {
                ...state.sessionStateById,
                [sessionId]: {
                  ...current,
                  hasUnread: true,
                },
              },
            }
          : {}),
      };
    });
    persistUnreadStateIfChanged(
      previousSessionStateById,
      get().sessionStateById,
    );
  },

  removeMessage: (sessionId, messageId) =>
    set((state) => {
      const messages = state.messagesBySession[sessionId];
      if (!messages) return state;
      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: messages.filter((m) => m.id !== messageId),
        },
      };
    }),

  setMessages: (sessionId, messages) => {
    let evictedSessionIds: string[] = [];
    set((state) => {
      const recentMessageSessionIds =
        state.activeSessionId === sessionId
          ? updateRecentMessageSessionIds(
              state.recentMessageSessionIds,
              sessionId,
            )
          : state.recentMessageSessionIds;
      const nextMessagesBySession = {
        ...state.messagesBySession,
        [sessionId]: messages,
      };
      const trimmedCache = trimMessageSessionCache(
        { ...state, messagesBySession: nextMessagesBySession },
        recentMessageSessionIds,
        [sessionId],
      );
      evictedSessionIds = trimmedCache.evictedSessionIds;

      return {
        messagesBySession: trimmedCache.messagesBySession,
        recentMessageSessionIds,
      };
    });
    evictedSessionIds.forEach(clearReplayBuffer);
  },

  clearMessages: (sessionId) => {
    const previousSessionStateById = get().sessionStateById;
    set((state) => ({
      messagesBySession: {
        ...state.messagesBySession,
        [sessionId]: [],
      },
      sessionStateById: {
        ...state.sessionStateById,
        [sessionId]: createInitialSessionRuntime(),
      },
    }));
    persistUnreadStateIfChanged(
      previousSessionStateById,
      get().sessionStateById,
    );
  },

  // Active session helpers
  getActiveMessages: () => {
    const { activeSessionId, messagesBySession } = get();
    if (!activeSessionId) return [];
    const messages = messagesBySession[activeSessionId] ?? [];
    return messages.filter((m) => m.metadata?.userVisible);
  },

  getSessionRuntime: (sessionId) =>
    get().sessionStateById[sessionId] ?? createInitialSessionRuntime(),

  // Streaming
  setStreamingMessageId: (sessionId, id) =>
    set((state) => {
      const existing = state.sessionStateById[sessionId];
      if (!existing && id === null) {
        return state;
      }

      const current = existing ?? createInitialSessionRuntime();
      const nextPendingInterventionBoundary =
        id === null ? null : current.pendingInterventionBoundary;
      if (
        current.streamingMessageId === id &&
        current.pendingInterventionBoundary === nextPendingInterventionBoundary
      ) {
        return state;
      }

      return {
        sessionStateById: {
          ...state.sessionStateById,
          [sessionId]: {
            ...current,
            streamingMessageId: id,
            pendingInterventionBoundary: nextPendingInterventionBoundary,
          },
        },
      };
    }),

  setActiveRunId: (sessionId, activeRunId) =>
    set((state) => ({
      sessionStateById: {
        ...state.sessionStateById,
        [sessionId]: {
          ...(state.sessionStateById[sessionId] ??
            createInitialSessionRuntime()),
          activeRunId,
        },
      },
    })),

  setRunCancellationPending: (sessionId, isRunCancellationPending) =>
    set((state) => ({
      sessionStateById: {
        ...state.sessionStateById,
        [sessionId]: {
          ...(state.sessionStateById[sessionId] ??
            createInitialSessionRuntime()),
          isRunCancellationPending,
        },
      },
    })),

  setPendingInterventionBoundary: (sessionId, pendingInterventionBoundary) =>
    set((state) => ({
      sessionStateById: {
        ...state.sessionStateById,
        [sessionId]: {
          ...(state.sessionStateById[sessionId] ??
            createInitialSessionRuntime()),
          pendingInterventionBoundary,
        },
      },
    })),

  setPendingAssistantProvider: (sessionId, pendingAssistantProviderId) =>
    set((state) => ({
      sessionStateById: {
        ...state.sessionStateById,
        [sessionId]: {
          ...(state.sessionStateById[sessionId] ??
            createInitialSessionRuntime()),
          pendingAssistantProviderId,
        },
      },
    })),

  appendToStreamingMessage: (sessionId, content) => {
    const previousSessionStateById = get().sessionStateById;
    set((state) => {
      const streamingMessageId =
        state.sessionStateById[sessionId]?.streamingMessageId ?? null;
      if (!streamingMessageId) return state;
      const messages = state.messagesBySession[sessionId];
      if (!messages) return state;

      let shouldMarkUnread = false;
      const updatedMessages = messages.map((message) => {
        if (message.id !== streamingMessageId) return message;

        shouldMarkUnread = shouldMarkSessionUnread(state, sessionId, message);
        return { ...message, content: [...message.content, content] };
      });

      const current =
        state.sessionStateById[sessionId] ?? createInitialSessionRuntime();

      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: updatedMessages,
        },
        ...(shouldMarkUnread
          ? {
              sessionStateById: {
                ...state.sessionStateById,
                [sessionId]: {
                  ...current,
                  hasUnread: true,
                },
              },
            }
          : {}),
      };
    });
    persistUnreadStateIfChanged(
      previousSessionStateById,
      get().sessionStateById,
    );
  },

  appendStreamingText: (sessionId, messageId, text) => {
    const previousSessionStateById = get().sessionStateById;
    let didUnreadStateChange = false;
    set((state) => {
      const messages = state.messagesBySession[sessionId];
      if (!messages) return state;

      const messageIndex = messages.findLastIndex(
        (message) => message.id === messageId,
      );
      const message = messages[messageIndex];
      if (!message) return state;

      let updatedMessage = message;
      if (text.length > 0) {
        const lastContent = message.content[message.content.length - 1];
        if (lastContent?.type === "text") {
          const nextContent = [...message.content];
          nextContent[nextContent.length - 1] = {
            ...lastContent,
            text: lastContent.text + text,
          };
          updatedMessage = { ...message, content: nextContent };
        } else {
          // Start a new text segment after non-text content so streamed tool
          // calls stay inline between text blocks.
          updatedMessage = {
            ...message,
            content: [...message.content, { type: "text" as const, text }],
          };
        }
      }

      const current =
        state.sessionStateById[sessionId] ?? createInitialSessionRuntime();
      const nextHasUnread =
        current.hasUnread || shouldMarkSessionUnread(state, sessionId, message);
      didUnreadStateChange = current.hasUnread !== nextHasUnread;
      const shouldUpdateRuntime =
        current.streamingMessageId !== messageId ||
        current.hasUnread !== nextHasUnread;
      const shouldUpdateMessage = updatedMessage !== message;

      if (!shouldUpdateMessage && !shouldUpdateRuntime) {
        return state;
      }

      const nextMessages = shouldUpdateMessage ? [...messages] : messages;
      if (shouldUpdateMessage) {
        nextMessages[messageIndex] = updatedMessage;
      }

      return {
        ...(shouldUpdateMessage
          ? {
              messagesBySession: {
                ...state.messagesBySession,
                [sessionId]: nextMessages,
              },
            }
          : {}),
        ...(shouldUpdateRuntime
          ? {
              sessionStateById: {
                ...state.sessionStateById,
                [sessionId]: {
                  ...current,
                  streamingMessageId: messageId,
                  hasUnread: nextHasUnread,
                },
              },
            }
          : {}),
      };
    });
    if (didUnreadStateChange) {
      persistUnreadStateIfChanged(
        previousSessionStateById,
        get().sessionStateById,
      );
    }
  },

  updateStreamingText: (sessionId, text) => {
    const streamingMessageId =
      get().sessionStateById[sessionId]?.streamingMessageId ?? null;
    if (!streamingMessageId) return;
    get().appendStreamingText(sessionId, streamingMessageId, text);
  },

  startAssistantStreamAfterIntervention: (sessionId) => {
    set((state) => {
      const messages = state.messagesBySession[sessionId];
      if (!messages) return state;

      const current =
        state.sessionStateById[sessionId] ?? createInitialSessionRuntime();
      const interventionMessageId =
        current.pendingInterventionBoundary?.interventionMessageId ??
        findLatestInterventionMessageId(messages);
      if (!interventionMessageId) return state;

      const interventionIndex = messages.findIndex(
        (message) => message.id === interventionMessageId,
      );
      const existingContinuationMessage =
        interventionIndex >= 0 ? messages[interventionIndex + 1] : undefined;
      if (
        existingContinuationMessage?.role === "assistant" &&
        existingContinuationMessage.metadata?.completionStatus === "inProgress"
      ) {
        return {
          sessionStateById: {
            ...state.sessionStateById,
            [sessionId]: {
              ...current,
              streamingMessageId: existingContinuationMessage.id,
              pendingInterventionBoundary: null,
            },
          },
        };
      }

      const streamingMessage = messages.find(
        (message) => message.id === current.streamingMessageId,
      );
      const assistantContinuationMessage =
        createAssistantContinuationMessage(streamingMessage);

      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: insertMessageAfter(
            messages,
            interventionMessageId,
            assistantContinuationMessage,
          ),
        },
        sessionStateById: {
          ...state.sessionStateById,
          [sessionId]: {
            ...current,
            streamingMessageId: assistantContinuationMessage.id,
            pendingInterventionBoundary: null,
          },
        },
      };
    });
  },

  // State
  setChatState: (sessionId, chatState) =>
    set((state) => ({
      sessionStateById: {
        ...state.sessionStateById,
        [sessionId]: {
          ...(state.sessionStateById[sessionId] ??
            createInitialSessionRuntime()),
          chatState,
        },
      },
    })),

  setError: (sessionId, error) =>
    set((state) => {
      const current =
        state.sessionStateById[sessionId] ?? createInitialSessionRuntime();
      return {
        sessionStateById: {
          ...state.sessionStateById,
          [sessionId]: {
            ...current,
            error,
            // Setting an error parks the session in "error"; clearing it must
            // return that parked state to "idle" so consumers that gate on
            // idle (the message queue, send routing) come back to life.
            // Clearing while in any other live state leaves it untouched.
            chatState: error
              ? ("error" as const)
              : current.chatState === "error"
                ? ("idle" as const)
                : current.chatState,
          },
        },
      };
    }),

  setConnected: (isConnected) => set({ isConnected }),

  markSessionRead: (sessionId) => {
    const previousSessionStateById = get().sessionStateById;
    set((state) => {
      const current =
        state.sessionStateById[sessionId] ?? createInitialSessionRuntime();
      if (!current.hasUnread) {
        return state;
      }
      return {
        sessionStateById: {
          ...state.sessionStateById,
          [sessionId]: {
            ...current,
            hasUnread: false,
          },
        },
      };
    });
    persistUnreadStateIfChanged(
      previousSessionStateById,
      get().sessionStateById,
    );
  },

  markSessionUnread: (sessionId) => {
    const previousSessionStateById = get().sessionStateById;
    set((state) => {
      const current =
        state.sessionStateById[sessionId] ?? createInitialSessionRuntime();
      if (current.hasUnread) {
        return state;
      }
      return {
        sessionStateById: {
          ...state.sessionStateById,
          [sessionId]: {
            ...current,
            hasUnread: true,
          },
        },
      };
    });
    persistUnreadStateIfChanged(
      previousSessionStateById,
      get().sessionStateById,
    );
  },

  // Token tracking
  updateTokenState: (sessionId, partial) =>
    set((state) => {
      const current =
        state.sessionStateById[sessionId]?.tokenState ?? INITIAL_TOKEN_STATE;
      const inputTokens = partial.inputTokens ?? current.inputTokens;
      const outputTokens = partial.outputTokens ?? current.outputTokens;
      const accumulatedInput =
        partial.accumulatedInput ??
        current.accumulatedInput + (partial.inputTokens ?? 0);
      const accumulatedOutput =
        partial.accumulatedOutput ??
        current.accumulatedOutput + (partial.outputTokens ?? 0);
      const accumulatedTotal =
        partial.accumulatedTotal ?? accumulatedInput + accumulatedOutput;
      return {
        sessionStateById: {
          ...state.sessionStateById,
          [sessionId]: {
            ...(state.sessionStateById[sessionId] ??
              createInitialSessionRuntime()),
            tokenState: {
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
              accumulatedInput,
              accumulatedOutput,
              accumulatedTotal,
              contextLimit: partial.contextLimit ?? current.contextLimit,
            },
            hasUsageSnapshot: true,
          },
        },
      };
    }),

  replaceTokenState: (sessionId, tokenState, hasUsageSnapshot = true) =>
    set((state) => ({
      sessionStateById: {
        ...state.sessionStateById,
        [sessionId]: {
          ...(state.sessionStateById[sessionId] ??
            createInitialSessionRuntime()),
          tokenState: { ...tokenState },
          hasUsageSnapshot,
        },
      },
    })),

  resetTokenState: (sessionId) =>
    set((state) => ({
      sessionStateById: {
        ...state.sessionStateById,
        [sessionId]: {
          ...(state.sessionStateById[sessionId] ??
            createInitialSessionRuntime()),
          tokenState: { ...INITIAL_TOKEN_STATE },
          hasUsageSnapshot: false,
        },
      },
    })),

  // Message queue
  enqueueMessage: (sessionId, message) =>
    set((state) => ({
      queuedMessageBySession: {
        ...state.queuedMessageBySession,
        [sessionId]: message,
      },
    })),

  dismissQueuedMessage: (sessionId) =>
    set((state) => {
      const { [sessionId]: _, ...rest } = state.queuedMessageBySession;
      return { queuedMessageBySession: rest };
    }),

  // Drafts
  setDraft: (sessionId, text) => {
    set((state) => ({
      draftsBySession: { ...state.draftsBySession, [sessionId]: text },
    }));
    persistDrafts(get().draftsBySession);
  },

  clearDraft: (sessionId) => {
    set((state) => {
      const { [sessionId]: _, ...rest } = state.draftsBySession;
      return { draftsBySession: rest };
    });
    persistDrafts(get().draftsBySession);
  },

  setSkillDrafts: (sessionId, skills) =>
    set((state) => {
      if (skills.length === 0) {
        const { [sessionId]: _, ...rest } = state.skillDraftsBySession;
        return { skillDraftsBySession: rest };
      }

      return {
        skillDraftsBySession: {
          ...state.skillDraftsBySession,
          [sessionId]: skills,
        },
      };
    }),

  clearSkillDrafts: (sessionId) =>
    set((state) => {
      const { [sessionId]: _, ...rest } = state.skillDraftsBySession;
      return { skillDraftsBySession: rest };
    }),

  // Session loading (replay)
  setSessionLoading: (sessionId, loading) =>
    set((state) => {
      const next = new Set(state.loadingSessionIds);
      if (loading) {
        next.add(sessionId);
      } else {
        next.delete(sessionId);
      }
      return { loadingSessionIds: next };
    }),

  setScrollTargetMessage: (sessionId, messageId, query) =>
    set((state) => ({
      scrollTargetMessageBySession: {
        ...state.scrollTargetMessageBySession,
        [sessionId]: { messageId, query },
      },
    })),

  clearScrollTargetMessage: (sessionId) =>
    set((state) => {
      if (!state.scrollTargetMessageBySession[sessionId]) {
        return state;
      }

      const nextTargets = { ...state.scrollTargetMessageBySession };
      delete nextTargets[sessionId];

      return {
        scrollTargetMessageBySession: nextTargets,
      };
    }),

  promoteSessionId: (draftSessionId, backendSessionId) => {
    const previousSessionStateById = get().sessionStateById;
    set((state) => {
      const { [draftSessionId]: messages, ...remainingMessages } =
        state.messagesBySession;
      const { [draftSessionId]: runtime, ...remainingRuntime } =
        state.sessionStateById;
      const { [draftSessionId]: queuedMessage, ...remainingQueued } =
        state.queuedMessageBySession;
      const { [draftSessionId]: draft, ...remainingDrafts } =
        state.draftsBySession;
      const { [draftSessionId]: skillDrafts, ...remainingSkillDrafts } =
        state.skillDraftsBySession;
      const { [draftSessionId]: scrollTarget, ...remainingTargets } =
        state.scrollTargetMessageBySession;
      const loadingSessionIds = new Set(state.loadingSessionIds);
      const wasLoading = loadingSessionIds.delete(draftSessionId);
      if (wasLoading) {
        loadingSessionIds.add(backendSessionId);
      }

      return {
        messagesBySession: messages
          ? { ...remainingMessages, [backendSessionId]: messages }
          : remainingMessages,
        sessionStateById: runtime
          ? { ...remainingRuntime, [backendSessionId]: runtime }
          : remainingRuntime,
        queuedMessageBySession: queuedMessage
          ? { ...remainingQueued, [backendSessionId]: queuedMessage }
          : remainingQueued,
        draftsBySession:
          draft !== undefined
            ? { ...remainingDrafts, [backendSessionId]: draft }
            : remainingDrafts,
        skillDraftsBySession: skillDrafts
          ? { ...remainingSkillDrafts, [backendSessionId]: skillDrafts }
          : remainingSkillDrafts,
        scrollTargetMessageBySession: scrollTarget
          ? { ...remainingTargets, [backendSessionId]: scrollTarget }
          : remainingTargets,
        loadingSessionIds,
        activeSessionId:
          state.activeSessionId === draftSessionId
            ? backendSessionId
            : state.activeSessionId,
        recentMessageSessionIds: replaceRecentMessageSessionId(
          state.recentMessageSessionIds,
          draftSessionId,
          backendSessionId,
        ),
      };
    });
    persistDrafts(get().draftsBySession);
    persistUnreadStateIfChanged(
      previousSessionStateById,
      get().sessionStateById,
    );
  },

  // Cleanup
  cleanupSession: (sessionId) => {
    // Discard any orphaned replay buffer so module-level Map doesn't leak.
    clearReplayBuffer(sessionId);
    const previousSessionStateById = get().sessionStateById;
    set((state) => {
      const { [sessionId]: _, ...rest } = state.messagesBySession;
      const { [sessionId]: __, ...remainingSessionState } =
        state.sessionStateById;
      const { [sessionId]: ___, ...remainingQueued } =
        state.queuedMessageBySession;
      const { [sessionId]: ____, ...remainingDrafts } = state.draftsBySession;
      const { [sessionId]: removedSkillDrafts, ...remainingSkillDrafts } =
        state.skillDraftsBySession;
      void removedSkillDrafts;
      const { [sessionId]: removedTarget, ...remainingTargets } =
        state.scrollTargetMessageBySession;
      void removedTarget;
      return {
        messagesBySession: rest,
        sessionStateById: remainingSessionState,
        queuedMessageBySession: remainingQueued,
        draftsBySession: remainingDrafts,
        skillDraftsBySession: remainingSkillDrafts,
        scrollTargetMessageBySession: remainingTargets,
        activeSessionId:
          state.activeSessionId === sessionId ? null : state.activeSessionId,
        recentMessageSessionIds: removeRecentMessageSessionId(
          state.recentMessageSessionIds,
          sessionId,
        ),
        isViewingActiveSession:
          state.activeSessionId === sessionId
            ? false
            : state.isViewingActiveSession,
      };
    });
    persistDrafts(get().draftsBySession);
    persistUnreadStateIfChanged(
      previousSessionStateById,
      get().sessionStateById,
    );
  },
});

export const useChatStore = create<ChatStore>()(
  subscribeWithSelector(createChatStore),
);
