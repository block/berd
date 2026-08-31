import { create } from "zustand";
import { acpCreateSession, acpListSessionsPage } from "@/shared/api/acp";
import type {
  WorkspaceAttachment,
  WorkspaceAttachmentLifecycle,
  WorkspaceAttachmentKind,
  WorkspaceAttachmentSource,
} from "@/shared/types/chat";
import { DEFAULT_CHAT_TITLE } from "@/features/chat/lib/sessionTitle";
import { messageSnippet } from "@/features/chat/lib/messageSnippet";
import {
  ensureWorkspaceAttachment,
  getWorkspaceAttachments,
  isSameWorkspacePath,
  removeWorkspaceAttachment,
  withWorkspaceBackfill,
} from "@/features/chat/lib/workspaceAttachments";
import {
  archiveSession as acpArchiveSession,
  unarchiveSession as acpUnarchiveSession,
} from "@/shared/api/acpApi";
import { mergeAcpSessionPage } from "@/features/chat/lib/acpSessionMapping";
import { releaseSession } from "@/features/chat/lib/sessionWindowCommands";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { useSecurityConfirmationStore } from "@/features/security/stores/securityConfirmationStore";
import {
  logReasoningEffortInfo,
  reasoningEffortConfigLogFields,
  shortLogId,
} from "@/shared/lib/reasoningEffortDiagnostics";
import {
  migratePersistedChatWorkspaceMetadata,
  persistChatWorkspaceMetadata,
  removePersistedChatWorkspaceMetadata,
} from "./workspaceAttachmentPersistence";
import {
  persistRemoteSessionRecord,
  removeRemoteSessionRecord,
} from "./remoteSessionPersistence";
import { backendIdForSession } from "@/shared/api/acpBackendId";
import {
  registerSessionBackend,
  transferSessionBackend,
} from "@/shared/api/acpSessionBackends";
import {
  materializeSessionExecutionModel,
  normalizeSessionExecutionTarget,
  sameSessionExecutionTarget,
  type SessionExecutionTarget,
} from "@/features/chat/lib/sessionExecutionTarget";
import { gooseServeSelectionFromExecutionTarget } from "@/features/chat/lib/gooseServeExecutionTarget";

const RIGHT_RAIL_OPEN_STORAGE_KEY = "goose:right-rail-open";
const LEGACY_CONTEXT_PANEL_OPEN_STORAGE_KEY = "goose:context-panel-open";

let sessionLoadEpoch = 0;
let archiveMutationOperationId = 0;
const inFlightArchiveMutationIdsBySessionId = new Map<string, Set<number>>();

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
  executionTarget?: SessionExecutionTarget;
  executionTargetSource?: "ui" | "acp";
  personaId?: string;
  reasoningEffort?: ChatSessionReasoningEffortConfig;
  workingDir?: string | null;
  /** SSH host whose backend owns this session; unset means local. */
  remoteHost?: string;
  workspaceAttachments?: WorkspaceAttachment[];
  activeWorkspaceId?: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
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
  agentBuilderOpen?: boolean;
  agentBuilderContextState?: "autoClosed" | "userOpened";
  targetAgentPath?: string | null;
  targetAgentSlug?: string | null;
  targetAgentDraftState?: "preparing" | "failed" | null;
  targetAgentDraftSaved?: boolean;
  /**
   * Existing-agent edits open with chat collapsed, while new-agent sessions
   * retain the default split view. This only seeds per-session view state.
   */
  agentBuilderChatStartCollapsed?: boolean;
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

export function hasSessionStarted(
  session: Pick<
    ChatSession,
    "messageCount" | "intent" | "targetAgentDraftSaved"
  >,
  localMessages?: ArrayLike<unknown> | number,
): boolean {
  const localMessageCount =
    typeof localMessages === "number"
      ? localMessages
      : (localMessages?.length ?? 0);
  return (
    session.messageCount > 0 ||
    localMessageCount > 0 ||
    session.targetAgentDraftSaved === true
  );
}

export function getVisibleSessions<
  T extends Pick<
    ChatSession,
    "id" | "messageCount" | "intent" | "targetAgentDraftSaved"
  >,
>(
  sessions: T[],
  messagesBySession: Record<string, ArrayLike<unknown> | number | undefined>,
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
  isRightRailOpen: boolean;
  activeWorkspaceBySession: Record<string, ActiveWorkspace>;
  archiveMutationBySessionId: ArchiveMutationBySessionId;
}

interface CreateSessionOpts {
  title?: string;
  projectId?: string;
  executionTarget?: SessionExecutionTarget;
  personaId?: string;
  workingDir?: string;
  remoteHost?: string;
  workspaceAttachments?: WorkspaceAttachment[];
  deferProviderSetup?: boolean;
}

interface AttachWorkspaceOpts {
  path: string;
  branch?: string | null;
  kind?: WorkspaceAttachmentKind;
  source?: WorkspaceAttachmentSource;
  repositoryPath?: string | null;
  worktreePath?: string | null;
  lifecycle?: WorkspaceAttachmentLifecycle | null;
  usedByAgent?: boolean;
}

interface ReplaceWorkspaceAttachmentOpts extends AttachWorkspaceOpts {
  oldAttachmentId: string;
}

export type ChatSessionPatch = Partial<
  Omit<ChatSession, "executionTarget" | "executionTargetSource">
>;

type ChatSessionPromotionPatch = ChatSessionPatch & {
  executionTarget?: SessionExecutionTarget;
};

interface ChatSessionStoreActions {
  createSession: (opts?: CreateSessionOpts) => Promise<ChatSession>;
  createDraftSession: (opts?: CreateSessionOpts) => ChatSession;
  promoteDraftSession: (
    draftSessionId: string,
    backendSessionId: string,
    patch?: ChatSessionPromotionPatch,
  ) => void;
  markSessionCreationFailed: (id: string, error: string) => void;
  resetSessionCreation: (id: string) => void;
  ensurePinnedSessionPlaceholder: (id: string) => void;
  loadSessions: () => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  patchSession: (id: string, patch: ChatSessionPatch) => void;
  updateSessionSubtitleFromText: (sessionId: string, text: string) => void;
  addSession: (session: ChatSession) => void;
  removeSession: (id: string) => void;
  /**
   * Archive a session optimistically (sets `archivedAt`), then awaits the
   * backend call. On backend failure `archivedAt` rolls back and the error is
   * rethrown. App-owned cleanup/navigation belongs in AppShell.
   * Throws {@link SessionNotFoundError} when the id matches no session.
   */
  archiveSession: (id: string, fallbackSession?: ChatSession) => Promise<void>;
  /**
   * Unarchive a session optimistically (clears `archivedAt`), then awaits the
   * backend call. On backend failure `archivedAt` rolls back and the error is
   * rethrown.
   */
  unarchiveSession: (id: string) => Promise<void>;

  setActiveSession: (sessionId: string | null) => void;
  setRightRailOpen: (open: boolean) => void;
  setActiveWorkspace: (sessionId: string, context: ActiveWorkspace) => void;
  clearActiveWorkspace: (sessionId: string) => void;
  attachWorkspace: (sessionId: string, workspace: AttachWorkspaceOpts) => void;
  replaceWorkspaceAttachment: (
    sessionId: string,
    workspace: ReplaceWorkspaceAttachmentOpts,
  ) => void;
  removeWorkspaceAttachment: (sessionId: string, attachmentId: string) => void;
  markWorkspaceUsedByAgent: (
    sessionId: string,
    path?: string | null,
    source?: WorkspaceAttachmentSource,
  ) => void;
  replaceSessionExecutionTarget: (
    sessionId: string,
    target: SessionExecutionTarget | undefined,
  ) => void;
  hydrateSessionExecutionTarget: (
    sessionId: string,
    target: SessionExecutionTarget,
  ) => void;

  getSession: (id: string) => ChatSession | undefined;
  getActiveSession: () => ChatSession | null;
  getArchivedSessions: () => ChatSession[];
}

export type ChatSessionStore = ChatSessionStoreState & ChatSessionStoreActions;

function patchIncludesReasoningEffort(patch: Partial<ChatSession>): boolean {
  return Object.hasOwn(patch, "reasoningEffort");
}

function sameReasoningEffortConfig(
  left: ChatSessionReasoningEffortConfig | undefined,
  right: ChatSessionReasoningEffortConfig | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.configId === right.configId &&
      left.currentValue === right.currentValue &&
      left.options.length === right.options.length &&
      left.options.every(
        (option, index) =>
          option.id === right.options[index]?.id &&
          option.name === right.options[index]?.name,
      ))
  );
}

function withExecutionTarget(
  session: ChatSession,
  executionTarget: SessionExecutionTarget | undefined,
  source: "ui" | "acp",
): ChatSession {
  const identityChanged = !sameSessionExecutionTarget(
    session.executionTarget,
    executionTarget,
  );
  if (
    !identityChanged &&
    session.executionTarget?.modelName === executionTarget?.modelName &&
    session.executionTargetSource === source
  ) {
    return session;
  }
  return {
    ...session,
    executionTarget,
    executionTargetSource: source,
    ...(identityChanged ? { reasoningEffort: undefined } : {}),
  };
}

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
    if (!state.sessions.some((candidate) => candidate.id === sessionId)) {
      const { [sessionId]: _completed, ...archiveMutationBySessionId } =
        state.archiveMutationBySessionId;
      return { archiveMutationBySessionId };
    }
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

function trackArchiveMutation(sessionId: string, operationId: number): void {
  const operations =
    inFlightArchiveMutationIdsBySessionId.get(sessionId) ?? new Set<number>();
  operations.add(operationId);
  inFlightArchiveMutationIdsBySessionId.set(sessionId, operations);
}

function settleArchiveMutationAndCancelIfArchived(
  state: ChatSessionStore,
  sessionId: string,
  operationId: number,
): void {
  const operations = inFlightArchiveMutationIdsBySessionId.get(sessionId);
  operations?.delete(operationId);
  if (operations?.size === 0) {
    inFlightArchiveMutationIdsBySessionId.delete(sessionId);
  }

  if (!operations?.size && state.getSession(sessionId)?.archivedAt) {
    useSecurityConfirmationStore.getState().cancelAll(sessionId);
  }
}

function loadRightRailOpenPreference(): boolean {
  if (typeof window === "undefined") return false;

  try {
    const storedValue = window.localStorage.getItem(
      RIGHT_RAIL_OPEN_STORAGE_KEY,
    );
    if (storedValue !== null) return storedValue === "1";

    const legacyValue = window.localStorage.getItem(
      LEGACY_CONTEXT_PANEL_OPEN_STORAGE_KEY,
    );
    if (legacyValue !== null) {
      window.localStorage.setItem(RIGHT_RAIL_OPEN_STORAGE_KEY, legacyValue);
      return legacyValue === "1";
    }
    return false;
  } catch {
    return false;
  }
}

function persistRightRailOpenPreference(open: boolean): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(RIGHT_RAIL_OPEN_STORAGE_KEY, open ? "1" : "0");
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

function persistRemoteSessionRecordForSession(session: ChatSession): void {
  if (!session.remoteHost) return;
  persistRemoteSessionRecord({
    sessionId: session.id,
    host: session.remoteHost,
    title: session.title,
    workingDir: session.workingDir ?? "",
    updatedAt: session.updatedAt,
    ...(session.projectId ? { projectId: session.projectId } : {}),
    ...(session.archivedAt ? { archivedAt: session.archivedAt } : {}),
  });
}

function persistWorkspaceMetadataForSession(session: ChatSession): void {
  persistChatWorkspaceMetadata(session.id, {
    workspaceAttachments: session.workspaceAttachments ?? [],
    activeWorkspaceId: session.activeWorkspaceId ?? null,
    workingDir: session.workingDir ?? null,
  });
}

export const useChatSessionStore = create<ChatSessionStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isLoading: false,
  isLoadingMoreSessions: false,
  hasHydratedSessions: false,
  sessionPageCursor: null,
  hasMoreSessions: false,
  isRightRailOpen: loadRightRailOpenPreference(),
  activeWorkspaceBySession: {},
  archiveMutationBySessionId: {},

  createSession: async (opts) => {
    if (!opts?.workingDir) {
      throw new Error("createSession requires a working directory");
    }
    const now = new Date().toISOString();
    const requestedExecutionTarget = normalizeSessionExecutionTarget(
      opts.executionTarget ?? { harnessId: "goose" },
    );
    const gooseServeSelection = gooseServeSelectionFromExecutionTarget(
      requestedExecutionTarget,
    );
    const providerId = gooseServeSelection.providerId ?? "goose";
    const requestedModelId = requestedExecutionTarget.modelId;
    const { sessionId, configOptionsSnapshot } = await acpCreateSession(
      providerId,
      opts.workingDir,
      {
        personaId: opts.personaId,
        modelId: requestedModelId,
        projectId: opts.projectId,
        deferProviderSetup: opts.deferProviderSetup ?? requestedModelId == null,
        // Creating on the remote backend also registers the session's backend,
        // so every later per-session call routes to the same host.
        remoteHost: opts.remoteHost,
      },
    );
    logReasoningEffortInfo("createSession acp resolved", {
      sessionId: shortLogId(sessionId),
      providerId,
      modelId: requestedModelId ?? null,
      hasReasoningEffort: Boolean(configOptionsSnapshot?.reasoningEffort),
    });
    const executionTarget =
      !requestedModelId && configOptionsSnapshot?.model
        ? (materializeSessionExecutionModel(
            requestedExecutionTarget,
            configOptionsSnapshot.model,
          ) ?? requestedExecutionTarget)
        : requestedExecutionTarget;
    const chatSession: ChatSession = withWorkspaceBackfill({
      id: sessionId,
      title: opts.title ?? DEFAULT_CHAT_TITLE,
      projectId: opts.projectId,
      executionTarget,
      executionTargetSource: "ui",
      personaId: opts.personaId,
      reasoningEffort: configOptionsSnapshot?.reasoningEffort ?? undefined,
      workingDir: opts.workingDir,
      ...(opts.remoteHost ? { remoteHost: opts.remoteHost } : {}),
      workspaceAttachments: opts.workspaceAttachments,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      intent: null,
      agentBuilderOpen: false,
      agentBuilderContextState: undefined,
      targetAgentPath: null,
      targetAgentSlug: null,
      targetAgentDraftState: null,
      targetAgentDraftSaved: false,
    });
    set((state) => ({ sessions: [chatSession, ...state.sessions] }));
    logReasoningEffortInfo("createSession inserted", {
      sessionId: shortLogId(sessionId),
      providerId,
      modelId: requestedModelId ?? null,
      hasReasoningEffort: Boolean(chatSession.reasoningEffort),
    });
    persistWorkspaceMetadataForSession(chatSession);
    persistRemoteSessionRecordForSession(chatSession);
    return chatSession;
  },

  createDraftSession: (opts) => {
    if (!opts?.workingDir) {
      throw new Error("createDraftSession requires a working directory");
    }
    const now = new Date().toISOString();
    const executionTarget = normalizeSessionExecutionTarget(
      opts.executionTarget ?? { harnessId: "goose" },
    );
    const id = crypto.randomUUID();
    const chatSession: ChatSession = withWorkspaceBackfill({
      id,
      title: opts.title ?? DEFAULT_CHAT_TITLE,
      projectId: opts.projectId,
      executionTarget,
      executionTargetSource: "ui",
      personaId: opts.personaId,
      workingDir: opts.workingDir,
      ...(opts.remoteHost ? { remoteHost: opts.remoteHost } : {}),
      workspaceAttachments: opts.workspaceAttachments,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      creationState: "pending",
      clientSessionId: id,
      intent: null,
      agentBuilderOpen: false,
      agentBuilderContextState: undefined,
      targetAgentPath: null,
      targetAgentSlug: null,
      targetAgentDraftState: null,
      targetAgentDraftSaved: false,
    });
    if (opts.remoteHost) {
      // Register the draft id too, so calls issued before promotion (e.g. the
      // creation request itself) route to the remote backend.
      registerSessionBackend(id, backendIdForSession(opts));
    }
    set((state) => ({ sessions: [chatSession, ...state.sessions] }));
    return chatSession;
  },

  promoteDraftSession: (draftSessionId, backendSessionId, patch = {}) => {
    let promotedForPersistence: ChatSession | null = null;
    set((state) => {
      const existingIndex = state.sessions.findIndex(
        (session) => session.id === draftSessionId,
      );
      if (existingIndex < 0) {
        logReasoningEffortInfo("promoteDraftSession missing draft", {
          draftSessionId: shortLogId(draftSessionId),
          backendSessionId: shortLogId(backendSessionId),
          patchIncludesReasoningEffort: patchIncludesReasoningEffort(patch),
        });
        return state;
      }

      const existing = state.sessions[existingIndex];
      const executionTargetWasPatched = Object.hasOwn(patch, "executionTarget");
      const executionTarget = executionTargetWasPatched
        ? patch.executionTarget
          ? normalizeSessionExecutionTarget(patch.executionTarget)
          : undefined
        : existing.executionTarget;
      const executionTargetChanged = !sameSessionExecutionTarget(
        existing.executionTarget,
        executionTarget,
      );
      let executionTargetSource = existing.executionTargetSource;
      if (executionTargetWasPatched) {
        executionTargetSource = "ui";
      }
      const promotedBase: ChatSession = {
        ...existing,
        ...patch,
        executionTarget,
        executionTargetSource,
        ...(executionTargetChanged && !patchIncludesReasoningEffort(patch)
          ? { reasoningEffort: undefined }
          : {}),
        id: backendSessionId,
        creationState: undefined,
        creationError: undefined,
        intent: patch.intent ?? existing.intent,
        agentBuilderOpen:
          patch.agentBuilderOpen !== undefined
            ? patch.agentBuilderOpen
            : existing.agentBuilderOpen,
        agentBuilderContextState: Object.hasOwn(
          patch,
          "agentBuilderContextState",
        )
          ? patch.agentBuilderContextState
          : existing.agentBuilderContextState,
        targetAgentPath:
          patch.targetAgentPath !== undefined
            ? patch.targetAgentPath
            : existing.targetAgentPath,
        targetAgentSlug:
          patch.targetAgentSlug !== undefined
            ? patch.targetAgentSlug
            : existing.targetAgentSlug,
        targetAgentDraftState:
          patch.targetAgentDraftState !== undefined
            ? patch.targetAgentDraftState
            : existing.targetAgentDraftState,
        targetAgentDraftSaved:
          patch.targetAgentDraftSaved !== undefined
            ? patch.targetAgentDraftSaved
            : existing.targetAgentDraftSaved,
        updatedAt: patch.updatedAt ?? existing.updatedAt,
      };
      const promoted: ChatSession =
        patch.workingDir !== undefined
          ? ensureWorkspaceAttachment(promotedBase, {
              path: patch.workingDir,
              source: "inferred",
              makeActive: true,
            })
          : withWorkspaceBackfill(promotedBase);
      promotedForPersistence = promoted;
      const sessions = state.sessions
        .filter((session) => session.id !== backendSessionId)
        .map((session) => (session.id === draftSessionId ? promoted : session));
      const { [draftSessionId]: workspace, ...remainingWorkspaces } =
        state.activeWorkspaceBySession;

      logReasoningEffortInfo("promoteDraftSession applied", {
        draftSessionId: shortLogId(draftSessionId),
        backendSessionId: shortLogId(backendSessionId),
        harnessId: promoted.executionTarget?.harnessId ?? null,
        modelProviderId: promoted.executionTarget?.modelProviderId ?? null,
        modelId: promoted.executionTarget?.modelId ?? null,
        patchIncludesReasoningEffort: patchIncludesReasoningEffort(patch),
        ...reasoningEffortConfigLogFields("previous", existing.reasoningEffort),
        ...reasoningEffortConfigLogFields("promoted", promoted.reasoningEffort),
      });
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
      };
    });
    // Typed alias: TS does not track the assignment inside the `set` callback,
    // so property access on the captured `let` would be on `never`.
    const promoted = promotedForPersistence as ChatSession | null;
    if (promoted) {
      // No-op for local sessions: the draft id is only registered when the
      // draft was created with a remote host.
      transferSessionBackend(draftSessionId, backendSessionId);
      migratePersistedChatWorkspaceMetadata(draftSessionId, backendSessionId);
      persistWorkspaceMetadataForSession(promoted);
      if (promoted.remoteHost) {
        removeRemoteSessionRecord(draftSessionId);
        persistRemoteSessionRecordForSession(promoted);
      }
    }
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
    if (Object.hasOwn(patch, "executionTarget")) {
      throw new Error(
        "Use replaceSessionExecutionTarget to change session execution state.",
      );
    }
    const includesReasoningEffort = patchIncludesReasoningEffort(patch);
    let sessionForWorkspacePersistence: ChatSession | null = null;
    let sessionForRemotePersistence: ChatSession | null = null;
    set((state) => {
      const existing = state.sessions.find((session) => session.id === id);
      if (!existing) {
        if (includesReasoningEffort) {
          logReasoningEffortInfo("patchSession missing session", {
            sessionId: shortLogId(id),
            patchHasReasoningEffort: patch.reasoningEffort !== undefined,
            ...reasoningEffortConfigLogFields("patch", patch.reasoningEffort),
          });
        }
        return state;
      }
      const reasoningEffortUnchanged =
        includesReasoningEffort &&
        sameReasoningEffortConfig(
          existing.reasoningEffort,
          patch.reasoningEffort,
        );
      if (reasoningEffortUnchanged && Object.keys(patch).length === 1) {
        return state;
      }
      const effectivePatch = reasoningEffortUnchanged
        ? { ...patch, reasoningEffort: existing.reasoningEffort }
        : patch;
      const mergedBase: ChatSession = {
        ...existing,
        ...effectivePatch,
        updatedAt: patch.updatedAt ?? existing.updatedAt,
      };
      const merged =
        patch.workingDir !== undefined
          ? ensureWorkspaceAttachment(mergedBase, {
              path: patch.workingDir,
              source: "inferred",
              makeActive: true,
            })
          : withWorkspaceBackfill(mergedBase);
      let changed = false;
      for (const key of Object.keys(merged) as (keyof ChatSession)[]) {
        if (merged[key] !== existing[key]) {
          changed = true;
          break;
        }
      }
      if (!changed) {
        if (includesReasoningEffort) {
          logReasoningEffortInfo("patchSession unchanged", {
            sessionId: shortLogId(id),
            patchHasReasoningEffort: patch.reasoningEffort !== undefined,
            ...reasoningEffortConfigLogFields(
              "existing",
              existing.reasoningEffort,
            ),
            ...reasoningEffortConfigLogFields("patch", patch.reasoningEffort),
          });
        }
        return state;
      }
      if (includesReasoningEffort) {
        logReasoningEffortInfo("patchSession applied", {
          sessionId: shortLogId(id),
          patchHasReasoningEffort: patch.reasoningEffort !== undefined,
          ...reasoningEffortConfigLogFields(
            "previous",
            existing.reasoningEffort,
          ),
          ...reasoningEffortConfigLogFields("next", merged.reasoningEffort),
        });
      }
      if (
        patch.workingDir !== undefined ||
        patch.workspaceAttachments !== undefined ||
        patch.activeWorkspaceId !== undefined
      ) {
        sessionForWorkspacePersistence = merged;
      }
      if (
        merged.remoteHost &&
        (merged.title !== existing.title ||
          merged.workingDir !== existing.workingDir ||
          merged.projectId !== existing.projectId ||
          merged.archivedAt !== existing.archivedAt ||
          merged.updatedAt !== existing.updatedAt)
      ) {
        sessionForRemotePersistence = merged;
      }
      return {
        sessions: state.sessions.map((session) =>
          session.id === id ? merged : session,
        ),
      };
    });
    if (sessionForWorkspacePersistence) {
      persistWorkspaceMetadataForSession(sessionForWorkspacePersistence);
    }
    if (sessionForRemotePersistence) {
      persistRemoteSessionRecordForSession(sessionForRemotePersistence);
    }
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
    let sessionForRemotePersistence: ChatSession | null = null;
    set((state) => {
      const existing = state.sessions.findIndex(
        (candidate) => candidate.id === session.id,
      );
      const backfilledSession = withWorkspaceBackfill(session);
      if (existing >= 0) {
        const updated = [...state.sessions];
        const merged = withWorkspaceBackfill({
          ...updated[existing],
          ...backfilledSession,
          workspaceAttachments:
            updated[existing].workspaceAttachments ??
            backfilledSession.workspaceAttachments,
          activeWorkspaceId:
            updated[existing].activeWorkspaceId ??
            backfilledSession.activeWorkspaceId,
        });
        updated[existing] = merged;
        if (merged.remoteHost) {
          sessionForRemotePersistence = merged;
        }
        return { sessions: updated };
      }
      if (backfilledSession.remoteHost) {
        sessionForRemotePersistence = backfilledSession;
      }
      return { sessions: [backfilledSession, ...state.sessions] };
    });
    if (sessionForRemotePersistence) {
      persistRemoteSessionRecordForSession(sessionForRemotePersistence);
    }
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
      const { [id]: _mutation, ...archiveMutationBySessionId } =
        state.archiveMutationBySessionId;

      return {
        sessions: nextSessions,
        activeSessionId:
          state.activeSessionId === id ? null : state.activeSessionId,
        activeWorkspaceBySession,
        archiveMutationBySessionId,
      };
    });
    removePersistedChatWorkspaceMetadata(id);
    removeRemoteSessionRecord(id);
    useSecurityConfirmationStore.getState().cancelAll(id);
    releaseWindowedSession(id);
  },

  archiveSession: async (id, fallbackSession) => {
    const storedSession = get().sessions.find(
      (candidate) => candidate.id === id,
    );
    const session = storedSession ?? fallbackSession;
    if (!session || session.id !== id) {
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
    trackArchiveMutation(id, operationId);
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
      settleArchiveMutationAndCancelIfArchived(get(), id, operationId);
      const archived = get().getSession(id);
      if (archived?.remoteHost) {
        persistRemoteSessionRecordForSession(archived);
      }
    } catch (error) {
      // Roll back only the archive flag; navigation/window cleanup is owned by
      // AppShell's archive transaction.
      set((state) => rollbackFailedArchiveMutation(state, id, operationId));
      settleArchiveMutationAndCancelIfArchived(get(), id, operationId);
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
    trackArchiveMutation(id, operationId);
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
      settleArchiveMutationAndCancelIfArchived(get(), id, operationId);
      const unarchived = get().getSession(id);
      if (unarchived?.remoteHost) {
        persistRemoteSessionRecordForSession(unarchived);
      }
    } catch (error) {
      set((state) => rollbackFailedArchiveMutation(state, id, operationId));
      settleArchiveMutationAndCancelIfArchived(get(), id, operationId);
      throw error;
    }
  },

  setActiveSession: (sessionId) => {
    if (get().activeSessionId === sessionId) return;
    set({ activeSessionId: sessionId });
  },

  setRightRailOpen: (open) => {
    persistRightRailOpenPreference(open);
    set({ isRightRailOpen: open });
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

  attachWorkspace: (sessionId, workspace) => {
    let sessionForWorkspacePersistence: ChatSession | null = null;
    set((state) => {
      const existing = state.sessions.find(
        (session) => session.id === sessionId,
      );
      if (!existing) return state;

      const nextSession = ensureWorkspaceAttachment(existing, {
        path: workspace.path,
        source: workspace.source ?? "selected",
        kind: workspace.kind,
        branch: workspace.branch,
        repositoryPath: workspace.repositoryPath,
        worktreePath: workspace.worktreePath,
        lifecycle: workspace.lifecycle,
        usedByAgent: workspace.usedByAgent,
        makeActive: false,
      });
      sessionForWorkspacePersistence = nextSession;

      return {
        sessions: state.sessions.map((session) =>
          session.id === sessionId ? nextSession : session,
        ),
      };
    });
    if (sessionForWorkspacePersistence) {
      persistWorkspaceMetadataForSession(sessionForWorkspacePersistence);
    }
  },

  replaceWorkspaceAttachment: (sessionId, workspace) => {
    let sessionForWorkspacePersistence: ChatSession | null = null;
    set((state) => {
      const existing = state.sessions.find(
        (session) => session.id === sessionId,
      );
      if (!existing) return state;
      const attachments = getWorkspaceAttachments(existing);
      const oldIndex = attachments.findIndex(
        (attachment) => attachment.id === workspace.oldAttachmentId,
      );
      if (oldIndex < 0) return state;

      const replacementSession: ChatSession = ensureWorkspaceAttachment(
        { ...existing, workspaceAttachments: [] as WorkspaceAttachment[] },
        {
          path: workspace.path,
          source: workspace.source ?? "selected",
          kind: workspace.kind,
          branch: workspace.branch,
          repositoryPath: workspace.repositoryPath,
          worktreePath: workspace.worktreePath,
          lifecycle: workspace.lifecycle,
          usedByAgent: workspace.usedByAgent,
          makeActive: false,
        },
      );
      const replacement = replacementSession.workspaceAttachments?.[0];
      if (!replacement) return state;
      const duplicateBeforeOld = attachments
        .slice(0, oldIndex)
        .filter((attachment) =>
          isSameWorkspacePath(attachment.path, replacement.path),
        ).length;
      const remaining = attachments.filter(
        (attachment, index) =>
          index === oldIndex ||
          !isSameWorkspacePath(attachment.path, replacement.path),
      );
      const replacementIndex = oldIndex - duplicateBeforeOld;
      const nextAttachments = [...remaining];
      nextAttachments[replacementIndex] = replacement;
      const nextSession = withWorkspaceBackfill({
        ...existing,
        workspaceAttachments: nextAttachments,
        activeWorkspaceId:
          existing.activeWorkspaceId === workspace.oldAttachmentId
            ? replacement.id
            : existing.activeWorkspaceId,
      });
      sessionForWorkspacePersistence = nextSession;
      const active = state.activeWorkspaceBySession[sessionId];
      return {
        sessions: state.sessions.map((session) =>
          session.id === sessionId ? nextSession : session,
        ),
        activeWorkspaceBySession:
          active &&
          isSameWorkspacePath(active.path, attachments[oldIndex]?.path)
            ? {
                ...state.activeWorkspaceBySession,
                [sessionId]: {
                  path: replacement.path,
                  branch: replacement.branch ?? null,
                },
              }
            : state.activeWorkspaceBySession,
      };
    });
    if (sessionForWorkspacePersistence) {
      persistWorkspaceMetadataForSession(sessionForWorkspacePersistence);
    }
  },

  removeWorkspaceAttachment: (sessionId, attachmentId) => {
    let sessionForWorkspacePersistence: ChatSession | null = null;
    set((state) => {
      const existing = state.sessions.find(
        (session) => session.id === sessionId,
      );
      if (!existing) return state;

      const removedWorkspacePath =
        getWorkspaceAttachments(existing).find(
          (attachment) => attachment.id === attachmentId,
        )?.path ??
        (attachmentId.startsWith("path:")
          ? attachmentId.slice("path:".length)
          : null);
      const nextSession = removeWorkspaceAttachment(existing, { attachmentId });
      sessionForWorkspacePersistence = nextSession;
      const activeWorkspace = state.activeWorkspaceBySession[sessionId];
      const shouldClearActiveWorkspace =
        activeWorkspace &&
        isSameWorkspacePath(activeWorkspace.path, removedWorkspacePath);
      const activeWorkspaceBySession = shouldClearActiveWorkspace
        ? Object.fromEntries(
            Object.entries(state.activeWorkspaceBySession).filter(
              ([activeSessionId]) => activeSessionId !== sessionId,
            ),
          )
        : state.activeWorkspaceBySession;

      return {
        sessions: state.sessions.map((session) =>
          session.id === sessionId ? nextSession : session,
        ),
        activeWorkspaceBySession,
      };
    });
    if (sessionForWorkspacePersistence) {
      persistWorkspaceMetadataForSession(sessionForWorkspacePersistence);
    }
  },

  markWorkspaceUsedByAgent: (sessionId, path, source) => {
    let sessionForWorkspacePersistence: ChatSession | null = null;
    set((state) => {
      const existing = state.sessions.find(
        (session) => session.id === sessionId,
      );
      if (!existing) return state;

      const activeWorkspacePath =
        state.activeWorkspaceBySession[sessionId]?.path;
      const workspacePath = path ?? activeWorkspacePath ?? null;
      if (!workspacePath) {
        const workspaceAttachments = getWorkspaceAttachments(existing);
        if (workspaceAttachments.length === 0) {
          return state;
        }
        const nextSession = withWorkspaceBackfill({
          ...existing,
          workspaceAttachments: workspaceAttachments.map((attachment) => ({
            ...attachment,
            usedByAgent: true,
          })),
        });
        sessionForWorkspacePersistence = nextSession;

        return {
          sessions: state.sessions.map((session) =>
            session.id === sessionId ? nextSession : session,
          ),
        };
      }

      const nextSession = ensureWorkspaceAttachment(existing, {
        path: workspacePath,
        source: source ?? (activeWorkspacePath ? "selected" : "inferred"),
        usedByAgent: true,
        makeActive: true,
      });
      sessionForWorkspacePersistence = nextSession;

      return {
        sessions: state.sessions.map((session) =>
          session.id === sessionId ? nextSession : session,
        ),
      };
    });
    if (sessionForWorkspacePersistence) {
      persistWorkspaceMetadataForSession(sessionForWorkspacePersistence);
    }
  },

  replaceSessionExecutionTarget: (sessionId, target) => {
    const normalizedTarget = target
      ? normalizeSessionExecutionTarget(target)
      : undefined;
    set((state) => {
      const existing = state.sessions.find(
        (session) => session.id === sessionId,
      );
      if (!existing) {
        return state;
      }
      const replacement = withExecutionTarget(existing, normalizedTarget, "ui");
      if (replacement === existing) {
        return state;
      }
      return {
        sessions: state.sessions.map((session) =>
          session.id === sessionId ? replacement : session,
        ),
      };
    });
  },

  hydrateSessionExecutionTarget: (sessionId, target) => {
    const normalizedTarget = normalizeSessionExecutionTarget(target);
    set((state) => {
      const existing = state.sessions.find(
        (session) => session.id === sessionId,
      );
      if (!existing || existing.executionTargetSource === "ui") {
        return state;
      }
      const replacement = withExecutionTarget(
        existing,
        normalizedTarget,
        "acp",
      );
      if (replacement === existing) return state;
      return {
        sessions: state.sessions.map((session) =>
          session.id === sessionId ? replacement : session,
        ),
      };
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
