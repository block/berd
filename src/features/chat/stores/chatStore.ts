import { create, type StateCreator } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type {
  ChatAttachmentDraft,
  Message,
  MessageContent,
} from "@/shared/types/messages";
import { completeAssistantMessage } from "@/features/chat/lib/messageCompletion";
import { clearReplayBuffer } from "../hooks/replayBuffer";
import { isSessionRunning } from "../lib/sessionActivity";
import type {
  ChatState,
  SessionChatRuntime,
  TokenState,
} from "@/shared/types/chat";
import {
  INITIAL_SESSION_CHAT_RUNTIME,
  INITIAL_TOKEN_STATE,
} from "@/shared/types/chat";
import type { ChatSkillDraft } from "../types";
import { loadCachedDrafts, persistDrafts } from "./draftPersistence";
import {
  loadCachedMessageQueues,
  persistMessageQueues,
} from "./queuePersistence";
import {
  loadCachedUnreadSessionIds,
  persistUnreadSessionIds,
} from "./unreadPersistence";
import {
  isAdmittedQueuedMessagePayload,
  type AdmittedQueuedMessagePayload,
  type QueuedMessagePayload,
} from "../lib/admittedSend";

const MESSAGE_SESSION_CACHE_LIMIT = 10;

function createInitialSessionRuntime(): SessionChatRuntime {
  return {
    ...INITIAL_SESSION_CHAT_RUNTIME,
    tokenState: { ...INITIAL_TOKEN_STATE },
  };
}

export function isSessionRuntimeSettled(runtime: SessionChatRuntime): boolean {
  return (
    runtime.chatState === "idle" &&
    runtime.activeRunId === null &&
    !runtime.isRunCancellationPending
  );
}

// Both fields are read from this store on purpose: pairing
// `isViewingActiveSession` with another store's `activeSessionId` only works
// while every call site updates both stores in lockstep.
export function isSessionActivelyViewed(
  state: Pick<ChatStoreState, "activeSessionId" | "isViewingActiveSession">,
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
    isSessionRuntimeSettled(runtime) && runtime.streamingMessageId === null
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

function preserveLocalSpeechState(
  currentMessages: readonly Message[] | undefined,
  nextMessages: readonly Message[],
): Message[] {
  const mergedMessages = nextMessages.map((message) => ({
    ...message,
    content: [...message.content],
  }));
  if (!currentMessages?.length) return mergedMessages;

  const nextById = new Map(
    mergedMessages.map((message) => [message.id, message]),
  );

  for (const current of currentMessages) {
    const replayedById = nextById.get(current.id);
    if (replayedById) {
      replayedById.content = replayedById.content.map((content, index) => {
        const currentContent = current.content[index];
        if (
          content.type !== "text" ||
          currentContent?.type !== "text" ||
          content.text !== currentContent.text ||
          !currentContent.speech
        ) {
          return content;
        }
        return { ...content, speech: currentContent.speech };
      });
    }
  }

  return mergedMessages;
}

function buildNonEmptyDraftSessionIds(
  draftsBySession: Record<string, string>,
): Set<string> {
  const sessionIds = new Set<string>();
  for (const [sessionId, draft] of Object.entries(draftsBySession)) {
    if (draft.length > 0) {
      sessionIds.add(sessionId);
    }
  }
  return sessionIds;
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
    ...Object.entries(state.mountedTranscriptCountBySession)
      .filter(([, count]) => count > 0)
      .map(([sessionId]) => sessionId),
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

function appendTextToMessage(message: Message, text: string): Message {
  if (text.length === 0) return message;

  const lastContent = message.content[message.content.length - 1];
  if (lastContent?.type === "text") {
    const nextContent = [...message.content];
    nextContent[nextContent.length - 1] = {
      ...lastContent,
      text: lastContent.text + text,
    };
    return { ...message, content: nextContent };
  }

  return {
    ...message,
    content: [...message.content, { type: "text" as const, text }],
  };
}

function appendThinkingChunksToMessage(
  message: Message,
  chunks: readonly string[],
): Message {
  let nextContent = message.content;
  let changed = false;

  for (const text of chunks) {
    const lastContent = nextContent[nextContent.length - 1];
    if (lastContent?.type !== "thinking") {
      nextContent = [...nextContent, { type: "thinking" as const, text }];
      changed = true;
      continue;
    }

    // Goose Core can emit thought updates either as deltas or as repeated /
    // cumulative snapshots depending on provider and replay path.
    let nextText: string;
    if (text === lastContent.text) {
      continue;
    }
    if (text.startsWith(lastContent.text)) {
      nextText = text;
    } else {
      nextText = lastContent.text + text;
    }

    const updatedContent = [...nextContent];
    updatedContent[updatedContent.length - 1] = {
      type: "thinking" as const,
      text: nextText,
    };
    nextContent = updatedContent;
    changed = true;
  }

  return changed ? { ...message, content: nextContent } : message;
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

function isDeliveredInterventionMessage(message: Message | undefined): boolean {
  return message?.role === "user" && message.metadata?.delivery === "steer";
}

function findInterventionInsertionAnchorIndex(
  messages: Message[],
  interventionIndex: number,
): number {
  let anchorIndex = interventionIndex;
  for (
    let index = interventionIndex + 1;
    index < messages.length && isDeliveredInterventionMessage(messages[index]);
    index += 1
  ) {
    anchorIndex = index;
  }
  return anchorIndex;
}

export type { QueuedMessagePayload, AdmittedQueuedMessagePayload };

export type QueuedMessageRecord =
  | {
      kind: "transport-ready";
      recordId: string;
      payload: AdmittedQueuedMessagePayload;
      releasedFromDeferred?: boolean;
      restored?: boolean;
      editing?: boolean;
    }
  | {
      kind: "deferred";
      recordId: string;
      payload: QueuedMessagePayload;
      state: unknown;
      restored?: boolean;
      editing?: boolean;
    };

export interface ScrollTargetMessage {
  messageId: string;
  query?: string;
}

export type StreamingMessageUpdate =
  | {
      kind: "text";
      sessionId: string;
      messageId: string;
      text: string;
    }
  | {
      kind: "thinking";
      sessionId: string;
      messageId: string;
      chunks: string[];
    };

export type StreamingMessageUpdateMode = "active-stream" | "settled-stream";

interface ChatStoreState {
  messagesBySession: Record<string, Message[]>;
  sessionStateById: Record<string, SessionChatRuntime>;
  queuedMessageBySession: Record<string, QueuedMessageRecord[]>;
  hasHydratedMessageQueues: boolean;
  draftsBySession: Record<string, string>;
  nonEmptyDraftSessionIds: Set<string>;
  skillDraftsBySession: Record<string, ChatSkillDraft[]>;
  draftAttachmentsBySession: Record<string, ChatAttachmentDraft[]>;
  activeSessionId: string | null;
  recentMessageSessionIds: string[];
  mountedTranscriptCountBySession: Record<string, number>;
  isViewingActiveSession: boolean;
  isConnected: boolean;
  loadingSessionIds: Set<string>;
  scrollTargetMessageBySession: Record<string, ScrollTargetMessage | null>;
}

interface ChatStoreActions {
  setActiveSession: (sessionId: string) => void;
  setActiveSessionViewing: (isViewing: boolean) => void;
  retainMountedTranscript: (sessionId: string) => () => void;
  addMessage: (sessionId: string, message: Message) => void;
  updateMessage: (
    sessionId: string,
    messageId: string,
    updater: (msg: Message) => Message,
  ) => void;
  replaceMessageId: (
    sessionId: string,
    messageId: string,
    replacementId: string,
  ) => void;
  removeMessage: (sessionId: string, messageId: string) => void;
  setMessages: (sessionId: string, messages: Message[]) => void;
  clearMessages: (sessionId: string) => void;
  getActiveMessages: () => Message[];
  getSessionRuntime: (sessionId: string) => SessionChatRuntime;
  setStreamingMessageId: (sessionId: string, id: string | null) => void;
  clearSettledStreamingMessage: (sessionId: string) => boolean;
  settleActiveRun: (sessionId: string) => void;
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
  appendStreamingMessageUpdates: (
    updates: StreamingMessageUpdate[],
    options: { mode: StreamingMessageUpdateMode },
  ) => void;
  updateStreamingText: (sessionId: string, text: string) => void;
  updateStreamingThinking: (sessionId: string, text: string) => void;
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
  enqueueDeferredMessage: (
    sessionId: string,
    payload: QueuedMessagePayload,
    state: unknown,
  ) => QueuedMessageRecord | null;
  updateDeferredMessage: (
    sessionId: string,
    recordId: string,
    state: unknown,
  ) => boolean;
  deferTransportReadyMessage: (
    sessionId: string,
    recordId: string,
    state: unknown,
    payload?: QueuedMessagePayload,
  ) => boolean;
  releaseDeferredMessage: (sessionId: string, recordId: string) => boolean;
  enqueueTransportReadyMessage: (
    sessionId: string,
    payload: AdmittedQueuedMessagePayload,
  ) => boolean;
  updateQueuedMessage: (
    sessionId: string,
    recordId: string,
    payload: QueuedMessagePayload,
  ) => boolean;
  setQueuedMessageEditing: (
    sessionId: string,
    recordId: string,
    editing: boolean,
  ) => boolean;
  replaceQueuedMessages: (
    queues: Record<string, QueuedMessageRecord[]>,
  ) => void;
  reconcileQueuedMessages: (
    queues: Record<string, QueuedMessageRecord[]>,
    sessionIds: string[],
  ) => void;
  markQueuedMessagesReady: (sessionId: string) => void;
  dismissQueuedMessage: (sessionId: string, expectedRecordId?: string) => void;
  moveQueuedMessage: (
    sourceSessionId: string,
    destinationSessionId: string,
    recordId?: string,
  ) => boolean;
  setDraft: (sessionId: string, text: string) => void;
  clearDraft: (sessionId: string) => void;
  setSkillDrafts: (sessionId: string, skills: ChatSkillDraft[]) => void;
  clearSkillDrafts: (sessionId: string) => void;
  setDraftAttachments: (
    sessionId: string,
    attachments: ChatAttachmentDraft[],
  ) => void;
  clearDraftAttachments: (sessionId: string) => void;
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

const cachedDrafts = loadCachedDrafts();
const cachedMessageQueues = loadCachedMessageQueues();

const createChatStore: StateCreator<
  ChatStore,
  [["zustand/subscribeWithSelector", never]]
> = (set, get) => ({
  // State
  messagesBySession: {},
  sessionStateById: buildInitialSessionStateById(),
  queuedMessageBySession: cachedMessageQueues,
  hasHydratedMessageQueues: false,
  draftsBySession: cachedDrafts,
  nonEmptyDraftSessionIds: buildNonEmptyDraftSessionIds(cachedDrafts),
  skillDraftsBySession: {},
  draftAttachmentsBySession: {},
  activeSessionId: null,
  recentMessageSessionIds: [],
  mountedTranscriptCountBySession: {},
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

  retainMountedTranscript: (sessionId) => {
    set((state) => ({
      mountedTranscriptCountBySession: {
        ...state.mountedTranscriptCountBySession,
        [sessionId]:
          (state.mountedTranscriptCountBySession[sessionId] ?? 0) + 1,
      },
    }));

    let released = false;
    return () => {
      if (released) return;
      released = true;
      let evictedSessionIds: string[] = [];
      set((state) => {
        const count = state.mountedTranscriptCountBySession[sessionId] ?? 0;
        if (count <= 0) return state;
        const mountedTranscriptCountBySession = {
          ...state.mountedTranscriptCountBySession,
        };
        if (count === 1) delete mountedTranscriptCountBySession[sessionId];
        else mountedTranscriptCountBySession[sessionId] = count - 1;
        const nextState = { ...state, mountedTranscriptCountBySession };
        const trimmedCache = trimMessageSessionCache(
          nextState,
          state.recentMessageSessionIds,
        );
        evictedSessionIds = trimmedCache.evictedSessionIds;
        return {
          mountedTranscriptCountBySession,
          messagesBySession: trimmedCache.messagesBySession,
        };
      });
      evictedSessionIds.forEach(clearReplayBuffer);
    };
  },

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

  replaceMessageId: (sessionId, messageId, replacementId) =>
    set((state) => {
      const messages = state.messagesBySession[sessionId];
      if (!messages || messageId === replacementId) return state;

      const current =
        state.sessionStateById[sessionId] ?? createInitialSessionRuntime();
      const nextPendingInterventionBoundary =
        current.pendingInterventionBoundary?.interventionMessageId === messageId
          ? { interventionMessageId: replacementId }
          : current.pendingInterventionBoundary;

      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: messages.map((message) =>
            message.id === messageId
              ? { ...message, id: replacementId }
              : message,
          ),
        },
        ...(nextPendingInterventionBoundary !==
        current.pendingInterventionBoundary
          ? {
              sessionStateById: {
                ...state.sessionStateById,
                [sessionId]: {
                  ...current,
                  pendingInterventionBoundary: nextPendingInterventionBoundary,
                },
              },
            }
          : {}),
      };
    }),

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
      const nextMessagesWithLocalVoice = preserveLocalSpeechState(
        state.messagesBySession[sessionId],
        messages,
      );
      const nextMessagesBySession = {
        ...state.messagesBySession,
        [sessionId]: nextMessagesWithLocalVoice,
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

  clearSettledStreamingMessage: (sessionId) => {
    let cleared = false;
    set((state) => {
      const runtime = state.sessionStateById[sessionId];
      if (
        !runtime ||
        !isSessionRuntimeSettled(runtime) ||
        (runtime.streamingMessageId === null &&
          runtime.pendingInterventionBoundary === null)
      ) {
        return state;
      }

      cleared = true;
      return {
        sessionStateById: {
          ...state.sessionStateById,
          [sessionId]: {
            ...runtime,
            streamingMessageId: null,
            pendingInterventionBoundary: null,
          },
        },
      };
    });
    return cleared;
  },

  settleActiveRun: (sessionId) =>
    set((state) => {
      const current = state.sessionStateById[sessionId];
      if (!current) return state;
      const shouldClearStreamTracking = !isSessionRunning(current.chatState);
      if (
        current.activeRunId === null &&
        !current.isRunCancellationPending &&
        (!shouldClearStreamTracking ||
          (current.streamingMessageId === null &&
            current.pendingInterventionBoundary === null))
      ) {
        return state;
      }

      return {
        sessionStateById: {
          ...state.sessionStateById,
          [sessionId]: {
            ...current,
            activeRunId: null,
            isRunCancellationPending: false,
            ...(shouldClearStreamTracking
              ? {
                  streamingMessageId: null,
                  pendingInterventionBoundary: null,
                }
              : {}),
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

      const updatedMessage = appendTextToMessage(message, text);

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

  appendStreamingMessageUpdates: (updates, { mode }) => {
    if (updates.length === 0) return;

    const isActiveStream = mode === "active-stream";
    const previousSessionStateById = get().sessionStateById;
    let didUnreadStateChange = false;
    set((state) => {
      let messagesBySession = state.messagesBySession;
      let sessionStateById = state.sessionStateById;

      for (const update of updates) {
        const messages = messagesBySession[update.sessionId];
        if (!messages) continue;

        const messageIndex = messages.findLastIndex(
          (message) => message.id === update.messageId,
        );
        const message = messages[messageIndex];
        if (!message) continue;

        const updatedMessage =
          update.kind === "text"
            ? appendTextToMessage(message, update.text)
            : appendThinkingChunksToMessage(message, update.chunks);
        const shouldUpdateMessage = updatedMessage !== message;
        const current =
          sessionStateById[update.sessionId] ?? createInitialSessionRuntime();
        const shouldMarkUnread =
          shouldUpdateMessage &&
          (update.kind === "text" || mode === "settled-stream") &&
          shouldMarkSessionUnread(state, update.sessionId, updatedMessage);
        const nextHasUnread = current.hasUnread || shouldMarkUnread;
        didUnreadStateChange ||= current.hasUnread !== nextHasUnread;
        const shouldUpdateRuntime =
          (isActiveStream && current.streamingMessageId !== update.messageId) ||
          current.hasUnread !== nextHasUnread;

        if (!shouldUpdateMessage && !shouldUpdateRuntime) continue;

        if (shouldUpdateMessage) {
          const nextMessages = [...messages];
          nextMessages[messageIndex] = updatedMessage;
          messagesBySession = {
            ...messagesBySession,
            [update.sessionId]: nextMessages,
          };
        }

        if (shouldUpdateRuntime) {
          sessionStateById = {
            ...sessionStateById,
            [update.sessionId]: {
              ...current,
              streamingMessageId: isActiveStream
                ? update.messageId
                : current.streamingMessageId,
              hasUnread: nextHasUnread,
            },
          };
        }
      }

      if (
        messagesBySession === state.messagesBySession &&
        sessionStateById === state.sessionStateById
      ) {
        return state;
      }
      return { messagesBySession, sessionStateById };
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

  updateStreamingThinking: (sessionId, text) => {
    set((state) => {
      const streamingMessageId =
        state.sessionStateById[sessionId]?.streamingMessageId ?? null;
      if (!streamingMessageId) return state;
      const messages = state.messagesBySession[sessionId];
      if (!messages) return state;

      let changed = false;
      const updatedMessages = messages.map((message) => {
        if (message.id !== streamingMessageId) return message;
        const updatedMessage = appendThinkingChunksToMessage(message, [text]);
        changed ||= updatedMessage !== message;
        return updatedMessage;
      });

      if (!changed) return state;

      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: updatedMessages,
        },
      };
    });
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
      const insertionAnchorIndex =
        interventionIndex >= 0
          ? findInterventionInsertionAnchorIndex(messages, interventionIndex)
          : -1;
      const insertionAnchorId = messages[insertionAnchorIndex]?.id;
      const existingContinuationMessage =
        insertionAnchorIndex >= 0
          ? messages[insertionAnchorIndex + 1]
          : undefined;
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
      const completedMessages = streamingMessage
        ? messages.map((message) =>
            message.id === streamingMessage.id
              ? completeAssistantMessage(message)
              : message,
          )
        : messages;

      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: insertionAnchorId
            ? insertMessageAfter(
                completedMessages,
                insertionAnchorId,
                assistantContinuationMessage,
              )
            : [...completedMessages, assistantContinuationMessage],
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
    set((state) => {
      const current =
        state.sessionStateById[sessionId] ?? createInitialSessionRuntime();
      const isIdle = chatState === "idle";
      const streamingMessageId = isIdle ? null : current.streamingMessageId;
      const pendingInterventionBoundary = isIdle
        ? null
        : current.pendingInterventionBoundary;
      if (
        current.chatState === chatState &&
        current.streamingMessageId === streamingMessageId &&
        current.pendingInterventionBoundary === pendingInterventionBoundary
      ) {
        return state;
      }

      return {
        sessionStateById: {
          ...state.sessionStateById,
          [sessionId]: {
            ...current,
            chatState,
            streamingMessageId,
            pendingInterventionBoundary,
          },
        },
      };
    }),

  setError: (sessionId, error) =>
    set((state) => {
      const current =
        state.sessionStateById[sessionId] ?? createInitialSessionRuntime();
      const clearParkedStream =
        error === null &&
        current.chatState === "error" &&
        current.activeRunId === null &&
        !current.isRunCancellationPending;
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
            ...(clearParkedStream
              ? {
                  streamingMessageId: null,
                  pendingInterventionBoundary: null,
                }
              : {}),
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
      const accumulatedCost =
        partial.accumulatedCost !== undefined
          ? partial.accumulatedCost
          : current.accumulatedCost;
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
              accumulatedCost,
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
  enqueueDeferredMessage: (sessionId, payload, deferredState) => {
    const queue = get().queuedMessageBySession[sessionId] ?? [];
    if (queue.some((record) => record.kind === "deferred")) return null;
    const record: QueuedMessageRecord = {
      kind: "deferred",
      recordId: crypto.randomUUID(),
      payload,
      state: deferredState,
    };
    set((state) => ({
      queuedMessageBySession: {
        ...state.queuedMessageBySession,
        [sessionId]: [
          ...(state.queuedMessageBySession[sessionId] ?? []),
          record,
        ],
      },
    }));
    persistMessageQueues(get().queuedMessageBySession, [sessionId]);
    return record;
  },

  updateDeferredMessage: (sessionId, recordId, deferredState) => {
    const queue = get().queuedMessageBySession[sessionId] ?? [];
    const index = queue.findIndex(
      (record) => record.kind === "deferred" && record.recordId === recordId,
    );
    if (index < 0) return false;
    const next = [...queue];
    next[index] = {
      ...queue[index],
      state: deferredState,
    } as QueuedMessageRecord;
    set((state) => ({
      queuedMessageBySession: {
        ...state.queuedMessageBySession,
        [sessionId]: next,
      },
    }));
    persistMessageQueues(get().queuedMessageBySession, [sessionId]);
    return true;
  },

  deferTransportReadyMessage: (sessionId, recordId, deferredState, payload) => {
    const queue = get().queuedMessageBySession[sessionId] ?? [];
    const index = queue.findIndex(
      (record) =>
        record.kind === "transport-ready" && record.recordId === recordId,
    );
    if (index < 0) return false;
    const record = queue[index];
    const next = [...queue];
    next[index] = {
      kind: "deferred",
      recordId,
      payload: payload ?? record.payload,
      state: deferredState,
      ...(record.editing ? { editing: true } : {}),
    };
    set((state) => ({
      queuedMessageBySession: {
        ...state.queuedMessageBySession,
        [sessionId]: next,
      },
    }));
    persistMessageQueues(get().queuedMessageBySession, [sessionId]);
    return true;
  },

  releaseDeferredMessage: (sessionId, recordId) => {
    const queue = get().queuedMessageBySession[sessionId] ?? [];
    const index = queue.findIndex(
      (record) => record.kind === "deferred" && record.recordId === recordId,
    );
    if (index < 0) return false;
    const record = queue[index];
    const next = [...queue];
    next[index] = {
      kind: "transport-ready",
      recordId,
      payload: record.payload,
      releasedFromDeferred: true,
      ...(record.editing ? { editing: true } : {}),
    };
    set((state) => ({
      queuedMessageBySession: {
        ...state.queuedMessageBySession,
        [sessionId]: next,
      },
    }));
    persistMessageQueues(get().queuedMessageBySession, [sessionId]);
    return true;
  },

  enqueueTransportReadyMessage: (sessionId, payload) => {
    const record: QueuedMessageRecord = {
      kind: "transport-ready",
      recordId: crypto.randomUUID(),
      payload,
    };
    set((state) => ({
      queuedMessageBySession: {
        ...state.queuedMessageBySession,
        [sessionId]: [
          ...(state.queuedMessageBySession[sessionId] ?? []),
          record,
        ],
      },
    }));
    persistMessageQueues(get().queuedMessageBySession, [sessionId]);
    return true;
  },

  updateQueuedMessage: (sessionId, recordId, payload) => {
    const queue = get().queuedMessageBySession[sessionId] ?? [];
    const index = queue.findIndex((record) => record.recordId === recordId);
    if (index < 0) return false;
    const next = [...queue];
    const { editing: _editing, ...record } = queue[index];
    const deferredState =
      record.kind === "deferred"
        ? (record.state as { status?: unknown })
        : undefined;
    if (
      record.kind === "deferred" &&
      (deferredState?.status === "held" || deferredState?.status === "failed")
    ) {
      if (!isAdmittedQueuedMessagePayload(payload)) return false;
      next[index] = {
        kind: "transport-ready",
        recordId,
        payload,
        releasedFromDeferred: true,
      };
    } else if (record.kind === "transport-ready") {
      if (!isAdmittedQueuedMessagePayload(payload)) return false;
      next[index] = { ...record, payload };
    } else {
      next[index] = { ...record, payload };
    }
    set((state) => ({
      queuedMessageBySession: {
        ...state.queuedMessageBySession,
        [sessionId]: next,
      },
    }));
    persistMessageQueues(get().queuedMessageBySession, [sessionId]);
    return true;
  },

  setQueuedMessageEditing: (sessionId, recordId, editing) => {
    const queue = get().queuedMessageBySession[sessionId] ?? [];
    const index = queue.findIndex((record) => record.recordId === recordId);
    if (index < 0) return false;
    const next = [...queue];
    const record = queue[index];
    if (editing) {
      next[index] = { ...record, editing: true };
    } else {
      const { editing: _editing, ...rest } = record;
      next[index] = rest as QueuedMessageRecord;
    }
    set((state) => ({
      queuedMessageBySession: {
        ...state.queuedMessageBySession,
        [sessionId]: next,
      },
    }));
    persistMessageQueues(get().queuedMessageBySession, [sessionId]);
    return true;
  },

  replaceQueuedMessages: (queues) => {
    set({ queuedMessageBySession: queues, hasHydratedMessageQueues: true });
  },

  reconcileQueuedMessages: (queues, sessionIds) => {
    set((state) => {
      const queuedMessageBySession = { ...state.queuedMessageBySession };
      for (const sessionId of sessionIds) {
        const queue = queues[sessionId];
        if (queue?.length) {
          queuedMessageBySession[sessionId] = queue;
        } else {
          delete queuedMessageBySession[sessionId];
        }
      }
      return { queuedMessageBySession };
    });
  },

  markQueuedMessagesReady: (sessionId) => {
    set((state) => {
      const queue = state.queuedMessageBySession[sessionId];
      if (!queue?.some((record) => record.restored)) return state;
      return {
        queuedMessageBySession: {
          ...state.queuedMessageBySession,
          [sessionId]: queue.map((record) => {
            const { restored: _restored, ...ready } = record;
            return ready as QueuedMessageRecord;
          }),
        },
      };
    });
  },

  dismissQueuedMessage: (sessionId, expectedRecordId) => {
    set((state) => {
      const queue = state.queuedMessageBySession[sessionId] ?? [];
      if (queue.length === 0) return state;
      const next = expectedRecordId
        ? queue.filter((record) => record.recordId !== expectedRecordId)
        : queue.slice(1);
      if (next.length === queue.length) return state;
      if (next.length > 0) {
        return {
          queuedMessageBySession: {
            ...state.queuedMessageBySession,
            [sessionId]: next,
          },
        };
      }
      const { [sessionId]: _, ...rest } = state.queuedMessageBySession;
      return { queuedMessageBySession: rest };
    });
    persistMessageQueues(get().queuedMessageBySession, [sessionId]);
  },

  moveQueuedMessage: (sourceSessionId, destinationSessionId, recordId) => {
    const state = get();
    const source = state.queuedMessageBySession[sourceSessionId] ?? [];
    const moved = recordId
      ? source.filter((record) => record.recordId === recordId)
      : source;
    if (moved.length === 0) return false;
    const remaining = recordId
      ? source.filter((record) => record.recordId !== recordId)
      : [];
    const destination =
      state.queuedMessageBySession[destinationSessionId] ?? [];
    set(({ queuedMessageBySession }) => {
      const next = { ...queuedMessageBySession };
      if (remaining.length > 0) {
        next[sourceSessionId] = remaining;
      } else {
        delete next[sourceSessionId];
      }
      next[destinationSessionId] = [...destination, ...moved];
      return { queuedMessageBySession: next };
    });
    persistMessageQueues(get().queuedMessageBySession, [
      sourceSessionId,
      destinationSessionId,
    ]);
    return true;
  },

  // Drafts
  setDraft: (sessionId, text) => {
    set((state) => {
      const previousDraft = state.draftsBySession[sessionId] ?? "";
      const hadDraft = previousDraft.length > 0;
      const hasDraft = text.length > 0;
      const nextDraftsBySession = {
        ...state.draftsBySession,
        [sessionId]: text,
      };

      if (hadDraft === hasDraft) {
        return { draftsBySession: nextDraftsBySession };
      }

      const nextNonEmptyDraftSessionIds = new Set(
        state.nonEmptyDraftSessionIds,
      );
      if (hasDraft) {
        nextNonEmptyDraftSessionIds.add(sessionId);
      } else {
        nextNonEmptyDraftSessionIds.delete(sessionId);
      }

      return {
        draftsBySession: nextDraftsBySession,
        nonEmptyDraftSessionIds: nextNonEmptyDraftSessionIds,
      };
    });
    persistDrafts(get().draftsBySession);
  },

  clearDraft: (sessionId) => {
    set((state) => {
      const { [sessionId]: _, ...rest } = state.draftsBySession;
      if (!state.nonEmptyDraftSessionIds.has(sessionId)) {
        return { draftsBySession: rest };
      }

      const nextNonEmptyDraftSessionIds = new Set(
        state.nonEmptyDraftSessionIds,
      );
      nextNonEmptyDraftSessionIds.delete(sessionId);
      return {
        draftsBySession: rest,
        nonEmptyDraftSessionIds: nextNonEmptyDraftSessionIds,
      };
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

  setDraftAttachments: (sessionId, attachments) =>
    set((state) => {
      if (attachments.length === 0) {
        const { [sessionId]: _, ...rest } = state.draftAttachmentsBySession;
        return { draftAttachmentsBySession: rest };
      }

      return {
        draftAttachmentsBySession: {
          ...state.draftAttachmentsBySession,
          [sessionId]: attachments,
        },
      };
    }),

  clearDraftAttachments: (sessionId) =>
    set((state) => {
      const { [sessionId]: _, ...rest } = state.draftAttachmentsBySession;
      return { draftAttachmentsBySession: rest };
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
      const destinationQueue = remainingQueued[backendSessionId] ?? [];
      const { [draftSessionId]: draft, ...remainingDrafts } =
        state.draftsBySession;
      const nonEmptyDraftSessionIds = new Set(state.nonEmptyDraftSessionIds);
      if (nonEmptyDraftSessionIds.delete(draftSessionId) && draft) {
        nonEmptyDraftSessionIds.add(backendSessionId);
      }
      const { [draftSessionId]: skillDrafts, ...remainingSkillDrafts } =
        state.skillDraftsBySession;
      const {
        [draftSessionId]: draftAttachments,
        ...remainingDraftAttachments
      } = state.draftAttachmentsBySession;
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
        queuedMessageBySession: queuedMessage?.length
          ? {
              ...remainingQueued,
              [backendSessionId]: [...destinationQueue, ...queuedMessage],
            }
          : remainingQueued,
        draftsBySession:
          draft !== undefined
            ? { ...remainingDrafts, [backendSessionId]: draft }
            : remainingDrafts,
        nonEmptyDraftSessionIds,
        skillDraftsBySession: skillDrafts
          ? { ...remainingSkillDrafts, [backendSessionId]: skillDrafts }
          : remainingSkillDrafts,
        draftAttachmentsBySession: draftAttachments
          ? {
              ...remainingDraftAttachments,
              [backendSessionId]: draftAttachments,
            }
          : remainingDraftAttachments,
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
    persistMessageQueues(get().queuedMessageBySession, [
      draftSessionId,
      backendSessionId,
    ]);
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
      const nonEmptyDraftSessionIds = new Set(state.nonEmptyDraftSessionIds);
      nonEmptyDraftSessionIds.delete(sessionId);
      const { [sessionId]: removedSkillDrafts, ...remainingSkillDrafts } =
        state.skillDraftsBySession;
      void removedSkillDrafts;
      const {
        [sessionId]: removedDraftAttachments,
        ...remainingDraftAttachments
      } = state.draftAttachmentsBySession;
      void removedDraftAttachments;
      const { [sessionId]: removedTarget, ...remainingTargets } =
        state.scrollTargetMessageBySession;
      void removedTarget;
      const {
        [sessionId]: removedMountedTranscriptCount,
        ...remainingMountedTranscriptCounts
      } = state.mountedTranscriptCountBySession;
      void removedMountedTranscriptCount;
      return {
        messagesBySession: rest,
        sessionStateById: remainingSessionState,
        queuedMessageBySession: remainingQueued,
        draftsBySession: remainingDrafts,
        nonEmptyDraftSessionIds,
        skillDraftsBySession: remainingSkillDrafts,
        draftAttachmentsBySession: remainingDraftAttachments,
        scrollTargetMessageBySession: remainingTargets,
        mountedTranscriptCountBySession: remainingMountedTranscriptCounts,
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
    persistMessageQueues(get().queuedMessageBySession, [sessionId]);
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
