import { create } from "zustand";
import { acpCreateSession, acpListSessionsPage } from "@/shared/api/acp";
import type { Session } from "@/shared/types/chat";
import { DEFAULT_CHAT_TITLE } from "@/features/chat/lib/sessionTitle";
import { messageSnippet } from "@/features/chat/lib/messageSnippet";
import {
  archiveSession as acpArchiveSession,
  unarchiveSession as acpUnarchiveSession,
} from "@/shared/api/acpApi";
import { mergeAcpSessionPage } from "@/features/chat/lib/acpSessionMapping";
import { releaseSession } from "@/features/chat/lib/sessionWindowCommands";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";

const CONTEXT_PANEL_OPEN_STORAGE_KEY = "goose:context-panel-open";

let sessionLoadEpoch = 0;
let archiveMutationOperationId = 0;

/** Thrown by archiveSession when the id matches no session in the store. */
export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`No session "${sessionId}"`);
    this.name = "SessionNotFoundError";
  }
}

export interface ChatSession {
  id: string;
  title: string;
  projectId?: string | null;
  providerId?: string;
  personaId?: string;
  modelId?: string;
  modelName?: string;
  reasoningEffort?: ChatSessionReasoningEffortConfig;
  workingDir?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  messageCount: number;
  /** First ~10 words of the session's latest real text message, or null. */
  subtitle?: string | null;
  userSetName?: boolean;
  creationState?: "pending" | "failed";
  creationError?: string;
  pinnedLoadState?: "loading" | "failed";
  clientSessionId?: string;
  intent?: "build-agent" | null;
  targetAgentPath?: string | null;
  targetAgentSlug?: string | null;
}

export interface ChatSessionReasoningEffortOption {
  id: string;
  name: string;
}

export interface ChatSessionReasoningEffortConfig {
  configId: string;
  currentValue: string;
  options: ChatSessionReasoningEffortOption[];
}

type ArchiveMutationStatus = "pending" | "succeeded";

export type ArchiveSessionMutation =
  | {
      operationId: number;
      desiredState: "archived";
      optimisticArchivedAt: string;
      previousArchivedAt?: string;
      status: ArchiveMutationStatus;
    }
  | {
      operationId: number;
      desiredState: "unarchived";
      previousArchivedAt?: string;
      status: ArchiveMutationStatus;
    };

export type ArchiveMutationBySessionId = Record<string, ArchiveSessionMutation>;

export interface ActiveWorkspace {
  path: string;
  branch: string | null;
}

export interface ModelSelectionIntent {
  requestId: string;
  kind: "model" | "provider";
  providerId?: string;
  modelId?: string;
  modelName?: string;
  previousProviderId?: string;
  previousModelId?: string;
  previousModelName?: string;
}

export function hasSessionStarted(
  session: Pick<ChatSession, "messageCount">,
  localMessages?: ArrayLike<unknown>,
): boolean {
  return session.messageCount > 0 || (localMessages?.length ?? 0) > 0;
}

export function getVisibleSessions<
  T extends Pick<ChatSession, "id" | "messageCount">,
>(
  sessions: T[],
  messagesBySession: Record<string, ArrayLike<unknown> | undefined>,
): T[] {
  return sessions.filter((session) =>
    hasSessionStarted(session, messagesBySession[session.id]),
  );
}

interface ChatSessionStoreState {
  sessions: ChatSession[];
  activeSessionId: string | null;
  isLoading: boolean;
  isLoadingMoreSessions: boolean;
  hasHydratedSessions: boolean;
  sessionPageCursor: string | null;
  hasMoreSessions: boolean;
  isContextPanelOpen: boolean;
  activeWorkspaceBySession: Record<string, ActiveWorkspace>;
  modelSelectionIntentBySession: Record<string, ModelSelectionIntent>;
  archiveMutationBySessionId: ArchiveMutationBySessionId;
}

interface CreateSessionOpts {
  title?: string;
  projectId?: string;
  providerId?: string;
  personaId?: string;
  workingDir?: string;
  modelId?: string;
  modelName?: string;
}

interface ChatSessionStoreActions {
  createSession: (opts?: CreateSessionOpts) => Promise<ChatSession>;
  createDraftSession: (opts?: CreateSessionOpts) => ChatSession;
  promoteDraftSession: (
    draftSessionId: string,
    backendSessionId: string,
    patch?: Partial<ChatSession>,
  ) => void;
  markSessionCreationFailed: (id: string, error: string) => void;
  resetSessionCreation: (id: string) => void;
  ensurePinnedSessionPlaceholder: (id: string) => void;
  loadSessions: () => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  patchSession: (id: string, patch: Partial<ChatSession>) => void;
  updateSessionSubtitleFromText: (sessionId: string, text: string) => void;
  addSession: (session: ChatSession) => void;
  removeSession: (id: string) => void;
  /**
   * Archive a session optimistically (sets `archivedAt`), then awaits the
   * backend call. On backend failure `archivedAt` rolls back and the error is
   * rethrown. App-owned cleanup/navigation belongs in AppShell.
   * Throws {@link SessionNotFoundError} when the id matches no session.
   */
  archiveSession: (id: string) => Promise<void>;
  /**
   * Unarchive a session optimistically (clears `archivedAt`), then awaits the
   * backend call. On backend failure `archivedAt` rolls back and the error is
   * rethrown.
   */
  unarchiveSession: (id: string) => Promise<void>;

  setActiveSession: (sessionId: string | null) => void;
  setContextPanelOpen: (sessionId: string, open: boolean) => void;
  setActiveWorkspace: (sessionId: string, context: ActiveWorkspace) => void;
  clearActiveWorkspace: (sessionId: string) => void;
  switchSessionProvider: (sessionId: string, providerId: string) => void;
  beginModelSelectionIntent: (
    sessionId: string,
    intent: ModelSelectionIntent,
  ) => void;
  getModelSelectionIntent: (
    sessionId: string,
  ) => ModelSelectionIntent | undefined;
  clearModelSelectionIntent: (sessionId: string, requestId?: string) => void;

  getSession: (id: string) => ChatSession | undefined;
  getActiveSession: () => ChatSession | null;
  getArchivedSessions: () => ChatSession[];
}

export type ChatSessionStore = ChatSessionStoreState & ChatSessionStoreActions;

function getArchiveMutationDesiredArchivedAt(
  mutation: ArchiveSessionMutation,
): string | undefined {
  return mutation.desiredState === "archived"
    ? mutation.optimisticArchivedAt
    : undefined;
}

function getArchiveMutationRollbackArchivedAt(
  session: ChatSession,
  existingMutation?: ArchiveSessionMutation,
): string | undefined {
  if (!existingMutation) {
    return session.archivedAt;
  }
  return existingMutation.status === "succeeded"
    ? getArchiveMutationDesiredArchivedAt(existingMutation)
    : existingMutation.previousArchivedAt;
}

function recordArchiveMutationSuccess(
  state: ChatSessionStore,
  sessionId: string,
  completedMutation: ArchiveSessionMutation,
): Partial<ChatSessionStore> | ChatSessionStore {
  const currentMutation = state.archiveMutationBySessionId[sessionId];
  const completedSucceededMutation = {
    ...completedMutation,
    status: "succeeded" as const,
  };

  if (!currentMutation) {
    if (!state.sessions.some((candidate) => candidate.id === sessionId)) {
      return state;
    }

    return {
      sessions: state.sessions.map((candidate) =>
        candidate.id === sessionId
          ? {
              ...candidate,
              archivedAt:
                getArchiveMutationDesiredArchivedAt(completedMutation),
            }
          : candidate,
      ),
      archiveMutationBySessionId: {
        ...state.archiveMutationBySessionId,
        [sessionId]: completedSucceededMutation,
      },
    };
  }

  if (currentMutation.operationId === completedMutation.operationId) {
    return {
      archiveMutationBySessionId: {
        ...state.archiveMutationBySessionId,
        [sessionId]: { ...currentMutation, status: "succeeded" as const },
      },
    };
  }

  return {
    archiveMutationBySessionId: {
      ...state.archiveMutationBySessionId,
      [sessionId]: {
        ...currentMutation,
        previousArchivedAt:
          getArchiveMutationDesiredArchivedAt(completedMutation),
      },
    },
  };
}

function rollbackFailedArchiveMutation(
  state: ChatSessionStore,
  sessionId: string,
  operationId: number,
): Partial<ChatSessionStore> | ChatSessionStore {
  const mutation = state.archiveMutationBySessionId[sessionId];
  if (!mutation || mutation.operationId !== operationId) {
    return state;
  }

  const { [sessionId]: _mutation, ...archiveMutationBySessionId } =
    state.archiveMutationBySessionId;
  return {
    sessions: state.sessions.map((candidate) =>
      candidate.id === sessionId
        ? { ...candidate, archivedAt: mutation.previousArchivedAt }
        : candidate,
    ),
    archiveMutationBySessionId,
  };
}

function loadContextPanelOpenPreference(): boolean {
  if (typeof window === "undefined") return false;

  try {
    return window.localStorage.getItem(CONTEXT_PANEL_OPEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function persistContextPanelOpenPreference(open: boolean): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      CONTEXT_PANEL_OPEN_STORAGE_KEY,
      open ? "1" : "0",
    );
  } catch {
    // localStorage may be unavailable
  }
}

function releaseWindowedSession(sessionId: string): void {
  if (!useSessionWindowStore.getState().isOpenInWindow(sessionId)) {
    return;
  }
  releaseSession(sessionId).catch((err: unknown) =>
    console.error("Failed to release session window:", err),
  );
}

export function sessionToChatSession(session: Session): ChatSession {
  return {
    id: session.id,
    title: session.title,
    projectId: session.projectId,
    providerId: session.providerId,
    personaId: session.personaId,
    modelId: session.modelId,
    modelName: session.modelName,
    workingDir: session.workingDir,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    archivedAt: session.archivedAt,
    messageCount: session.messageCount,
    userSetName: session.userSetName,
  };
}

export const useChatSessionStore = create<ChatSessionStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isLoading: false,
  isLoadingMoreSessions: false,
  hasHydratedSessions: false,
  sessionPageCursor: null,
  hasMoreSessions: false,
  isContextPanelOpen: loadContextPanelOpenPreference(),
  activeWorkspaceBySession: {},
  modelSelectionIntentBySession: {},
  archiveMutationBySessionId: {},

  createSession: async (opts) => {
    if (!opts?.workingDir) {
      throw new Error("createSession requires a working directory");
    }
    const now = new Date().toISOString();
    const providerId = opts.providerId ?? "goose";
    const { sessionId } = await acpCreateSession(providerId, opts.workingDir, {
      personaId: opts.personaId,
      modelId: opts.modelId,
      projectId: opts.projectId,
    });
    const chatSession: ChatSession = {
      id: sessionId,
      title: opts.title ?? DEFAULT_CHAT_TITLE,
      projectId: opts.projectId,
      providerId,
      personaId: opts.personaId,
      modelId: opts.modelId,
      modelName: opts.modelName,
      workingDir: opts.workingDir,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      intent: null,
      targetAgentPath: null,
      targetAgentSlug: null,
    };
    set((state) => ({ sessions: [chatSession, ...state.sessions] }));
    return chatSession;
  },

  createDraftSession: (opts) => {
    if (!opts?.workingDir) {
      throw new Error("createDraftSession requires a working directory");
    }
    const now = new Date().toISOString();
    const providerId = opts.providerId ?? "goose";
    const id = crypto.randomUUID();
    const chatSession: ChatSession = {
      id,
      title: opts.title ?? DEFAULT_CHAT_TITLE,
      projectId: opts.projectId,
      providerId,
      personaId: opts.personaId,
      modelId: opts.modelId,
      modelName: opts.modelName,
      workingDir: opts.workingDir,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      creationState: "pending",
      clientSessionId: id,
      intent: null,
      targetAgentPath: null,
      targetAgentSlug: null,
    };
    set((state) => ({ sessions: [chatSession, ...state.sessions] }));
    return chatSession;
  },

  promoteDraftSession: (draftSessionId, backendSessionId, patch = {}) => {
    set((state) => {
      const existingIndex = state.sessions.findIndex(
        (session) => session.id === draftSessionId,
      );
      if (existingIndex < 0) {
        return state;
      }

      const existing = state.sessions[existingIndex];
      const promoted: ChatSession = {
        ...existing,
        ...patch,
        id: backendSessionId,
        creationState: undefined,
        creationError: undefined,
        updatedAt: patch.updatedAt ?? existing.updatedAt,
      };
      const sessions = state.sessions
        .filter((session) => session.id !== backendSessionId)
        .map((session) => (session.id === draftSessionId ? promoted : session));
      const { [draftSessionId]: workspace, ...remainingWorkspaces } =
        state.activeWorkspaceBySession;
      const { [draftSessionId]: intent, ...remainingIntents } =
        state.modelSelectionIntentBySession;

      return {
        sessions,
        activeSessionId:
          state.activeSessionId === draftSessionId
            ? backendSessionId
            : state.activeSessionId,
        activeWorkspaceBySession: workspace
          ? {
              ...remainingWorkspaces,
              [backendSessionId]: workspace,
            }
          : remainingWorkspaces,
        modelSelectionIntentBySession: intent
          ? {
              ...remainingIntents,
              [backendSessionId]: intent,
            }
          : remainingIntents,
      };
    });
  },

  markSessionCreationFailed: (id, error) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id
          ? {
              ...session,
              creationState: "failed" as const,
              creationError: error,
              updatedAt: new Date().toISOString(),
            }
          : session,
      ),
    }));
  },

  resetSessionCreation: (id) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id && session.creationState === "failed"
          ? {
              ...session,
              creationState: "pending" as const,
              creationError: undefined,
              updatedAt: new Date().toISOString(),
            }
          : session,
      ),
    }));
  },

  ensurePinnedSessionPlaceholder: (id) => {
    set((state) => {
      const existing = state.sessions.find((session) => session.id === id);
      if (existing) {
        if (existing.creationState || existing.pinnedLoadState === "loading") {
          return state;
        }
        return {
          sessions: state.sessions.map((session) =>
            session.id === id
              ? { ...session, pinnedLoadState: "loading" as const }
              : session,
          ),
        };
      }

      const now = new Date().toISOString();
      const placeholder: ChatSession = {
        id,
        title: DEFAULT_CHAT_TITLE,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        pinnedLoadState: "loading",
      };
      return { sessions: [placeholder, ...state.sessions] };
    });
  },

  loadSessions: async () => {
    const loadEpoch = ++sessionLoadEpoch;
    set({ isLoading: true });
    try {
      const page = await acpListSessionsPage();
      if (sessionLoadEpoch !== loadEpoch) return;
      set((state) => mergeAcpSessionPage(state, page, null));
    } catch (error) {
      if (sessionLoadEpoch === loadEpoch) {
        console.error("Failed to load sessions from ACP:", error);
      }
    } finally {
      if (sessionLoadEpoch === loadEpoch) {
        set({ isLoading: false, hasHydratedSessions: true });
      }
    }
  },

  loadMoreSessions: async () => {
    const { sessionPageCursor, hasMoreSessions, isLoadingMoreSessions } = get();
    if (isLoadingMoreSessions || !hasMoreSessions) {
      return;
    }

    const loadEpoch = sessionLoadEpoch;
    set({ isLoadingMoreSessions: true });
    try {
      const page = await acpListSessionsPage({ cursor: sessionPageCursor });
      if (sessionLoadEpoch !== loadEpoch) return;
      set((state) => mergeAcpSessionPage(state, page, sessionPageCursor));
    } catch (error) {
      if (sessionLoadEpoch === loadEpoch) {
        console.error("Failed to load more sessions from ACP:", error);
      }
    } finally {
      set({ isLoadingMoreSessions: false });
    }
  },

  patchSession: (id, patch) => {
    set((state) => {
      const existing = state.sessions.find((session) => session.id === id);
      if (!existing) return state;
      const merged: ChatSession = {
        ...existing,
        ...patch,
        updatedAt: patch.updatedAt ?? existing.updatedAt,
      };
      let changed = false;
      for (const key of Object.keys(merged) as (keyof ChatSession)[]) {
        if (merged[key] !== existing[key]) {
          changed = true;
          break;
        }
      }
      if (!changed) return state;
      return {
        sessions: state.sessions.map((session) =>
          session.id === id ? merged : session,
        ),
      };
    });
  },

  // Update a session's sidebar subtitle in place from raw message text, mirroring
  // the backend's last-message-snippet append path. Lets the subtitle track live
  // streamed text without an extra session/list load; the next full loadSessions()
  // still reconciles to the backend's canonical snippet.
  updateSessionSubtitleFromText: (sessionId, text) => {
    const snippet = messageSnippet(text);
    // Tool-only / thinking-only / image-only / whitespace-only messages produce
    // no snippet — leave the prior subtitle intact, never clear it. patchSession
    // guards an unknown id and compare-and-skips when the subtitle is unchanged.
    if (snippet === null) return;
    get().patchSession(sessionId, { subtitle: snippet });
  },

  addSession: (session) => {
    set((state) => {
      const existing = state.sessions.findIndex(
        (candidate) => candidate.id === session.id,
      );
      if (existing >= 0) {
        const updated = [...state.sessions];
        updated[existing] = { ...updated[existing], ...session };
        return { sessions: updated };
      }
      return { sessions: [session, ...state.sessions] };
    });
  },

  removeSession: (id) => {
    set((state) => {
      const nextSessions = state.sessions.filter(
        (session) => session.id !== id,
      );
      const hasMutation = id in state.archiveMutationBySessionId;
      if (nextSessions.length === state.sessions.length && !hasMutation) {
        return state;
      }

      const { [id]: _workspace, ...activeWorkspaceBySession } =
        state.activeWorkspaceBySession;
      const { [id]: _intent, ...modelSelectionIntentBySession } =
        state.modelSelectionIntentBySession;
      const { [id]: _mutation, ...archiveMutationBySessionId } =
        state.archiveMutationBySessionId;

      return {
        sessions: nextSessions,
        activeSessionId:
          state.activeSessionId === id ? null : state.activeSessionId,
        activeWorkspaceBySession,
        modelSelectionIntentBySession,
        archiveMutationBySessionId,
      };
    });
    releaseWindowedSession(id);
  },

  archiveSession: async (id) => {
    const session = get().sessions.find((candidate) => candidate.id === id);
    if (!session) {
      throw new SessionNotFoundError(id);
    }
    const optimisticArchivedAt = new Date().toISOString();
    const operationId = ++archiveMutationOperationId;
    const mutation: ArchiveSessionMutation = {
      operationId,
      desiredState: "archived",
      optimisticArchivedAt,
      previousArchivedAt: getArchiveMutationRollbackArchivedAt(
        session,
        get().archiveMutationBySessionId[id],
      ),
      status: "pending",
    };
    set((state) => ({
      sessions: state.sessions.map((candidate) =>
        candidate.id === id
          ? { ...candidate, archivedAt: optimisticArchivedAt }
          : candidate,
      ),
      archiveMutationBySessionId: {
        ...state.archiveMutationBySessionId,
        [id]: mutation,
      },
    }));
    try {
      await acpArchiveSession(session.id);
      set((state) => recordArchiveMutationSuccess(state, id, mutation));
    } catch (error) {
      // Roll back only the archive flag; navigation/window cleanup is owned by
      // AppShell's archive transaction.
      set((state) => rollbackFailedArchiveMutation(state, id, operationId));
      throw error;
    }
  },

  unarchiveSession: async (id) => {
    const session = get().sessions.find((candidate) => candidate.id === id);
    if (!session) {
      return;
    }
    const operationId = ++archiveMutationOperationId;
    const mutation: ArchiveSessionMutation = {
      operationId,
      desiredState: "unarchived",
      previousArchivedAt: getArchiveMutationRollbackArchivedAt(
        session,
        get().archiveMutationBySessionId[id],
      ),
      status: "pending",
    };
    set((state) => ({
      sessions: state.sessions.map((candidate) =>
        candidate.id === id
          ? { ...candidate, archivedAt: undefined }
          : candidate,
      ),
      archiveMutationBySessionId: {
        ...state.archiveMutationBySessionId,
        [id]: mutation,
      },
    }));
    try {
      await acpUnarchiveSession(session.id);
      set((state) => recordArchiveMutationSuccess(state, id, mutation));
    } catch (error) {
      set((state) => rollbackFailedArchiveMutation(state, id, operationId));
      throw error;
    }
  },

  setActiveSession: (sessionId) => {
    if (get().activeSessionId === sessionId) return;
    set({ activeSessionId: sessionId });
  },

  setContextPanelOpen: (_sessionId, open) => {
    persistContextPanelOpenPreference(open);
    set({ isContextPanelOpen: open });
  },

  setActiveWorkspace: (sessionId, context) => {
    set((state) => {
      const existing = state.activeWorkspaceBySession[sessionId];
      if (
        existing &&
        existing.path === context.path &&
        existing.branch === context.branch
      ) {
        return state;
      }
      return {
        activeWorkspaceBySession: {
          ...state.activeWorkspaceBySession,
          [sessionId]: context,
        },
      };
    });
  },

  clearActiveWorkspace: (sessionId) => {
    set((state) => {
      if (!(sessionId in state.activeWorkspaceBySession)) return state;
      const { [sessionId]: _, ...rest } = state.activeWorkspaceBySession;
      return { activeWorkspaceBySession: rest };
    });
  },

  switchSessionProvider: (sessionId, providerId) => {
    set((state) => {
      const existing = state.sessions.find((s) => s.id === sessionId);
      if (!existing) return state;
      if (
        existing.providerId === providerId &&
        existing.modelId === undefined &&
        existing.modelName === undefined
      ) {
        return state;
      }
      return {
        sessions: state.sessions.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                providerId,
                modelId: undefined,
                modelName: undefined,
                reasoningEffort: undefined,
                updatedAt: session.updatedAt,
              }
            : session,
        ),
      };
    });
  },

  beginModelSelectionIntent: (sessionId, intent) => {
    set((state) => ({
      modelSelectionIntentBySession: {
        ...state.modelSelectionIntentBySession,
        [sessionId]: intent,
      },
    }));
  },

  getModelSelectionIntent: (sessionId) =>
    get().modelSelectionIntentBySession[sessionId],

  clearModelSelectionIntent: (sessionId, requestId) => {
    const current = get().modelSelectionIntentBySession[sessionId];
    if (!current || (requestId && current.requestId !== requestId)) {
      return;
    }

    set((state) => {
      const modelSelectionIntentBySession = {
        ...state.modelSelectionIntentBySession,
      };
      delete modelSelectionIntentBySession[sessionId];
      return { modelSelectionIntentBySession };
    });
  },

  getSession: (id) => get().sessions.find((session) => session.id === id),

  getActiveSession: () => {
    const { activeSessionId, sessions } = get();
    if (!activeSessionId) return null;
    return sessions.find((session) => session.id === activeSessionId) ?? null;
  },

  getArchivedSessions: () =>
    get().sessions.filter((session) => !!session.archivedAt),
}));
