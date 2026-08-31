import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { QueryClientContext } from "@tanstack/react-query";
import type { ChatAttachmentDraft } from "@/shared/types/messages";
import type { ChatSendOptions, ChatSkillDraft, ModelOption } from "../types";
import { INITIAL_TOKEN_STATE } from "@/shared/types/chat";
import { useChat } from "./useChat";
import { useAutoCompactPreferences } from "./useAutoCompactPreferences";
import { useMessageQueue } from "./useMessageQueue";
import { useChatStore, type QueuedMessagePayload } from "../stores/chatStore";
import { personaIntentFromComposer } from "../lib/admittedSend";
import {
  hasSessionStarted,
  useChatSessionStore,
  type ChatSession,
} from "../stores/chatSessionStore";
import { toast } from "sonner";
import { i18n } from "@/shared/i18n";
import { REMOTE_SSH_SESSIONS_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { useExperiment } from "@/features/experiments/experimentPreferences";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import {
  ensureRemoteHostConnected,
  isRemoteSession,
} from "../lib/remoteSession";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { selectPersonas } from "@/features/agents/stores/agentSelectors";
import { useProviderSelection } from "@/features/agents/hooks/useProviderSelection";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { isAskWorktreeStartupMode } from "@/features/projects/api/projects";
import { selectProjects } from "@/features/projects/stores/projectSelectors";
import { resolveAgentProviderCatalogIdStrictFromEntries } from "@/features/providers/providerCatalog";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { resolveSelectedAgentId } from "@/features/chat/lib/agentProviderResolution";
import {
  composeSystemPrompt,
  formatArtifactFolderInstructions,
  formatPersonaSystemPrompt,
  resolveProjectDefaultArtifactRoot,
} from "@/features/projects/lib/chatProjectContext";
import { formatIncludedWorkspacesPrompt } from "@/features/chat/lib/workspaceAttachments";
import { useWorkspaceRepository } from "@/features/workspaces/workspaceRepository";
import { loadWorkspaceInstructionFiles } from "@/features/chat/api/workspaceContext";
import { formatWorkspaceInstructionsPrompt } from "@/features/chat/lib/workspaceContextPrompt";
import { getSkillProviderCapabilities } from "@/features/chat/lib/skillProviderCapabilities";
import {
  fetchBerdAppSkills,
  fetchSkillsList,
} from "@/features/skills/api/skillsQuery";
import { listenSkillsChanged } from "@/features/skills/lib/skillsEvents";
import { formatAvailableSkillsCatalogPrompt } from "@/features/skills/lib/skillChatPrompt";
import { setStoredModelPreference } from "../lib/modelPreferences";
import { saveDefaultReasoningEffort } from "../lib/reasoningEffortPreferences";
import {
  replaceSessionTargetAfterDispatch,
  transitionSessionTarget,
} from "../lib/sessionTargetCoordinator";
import { applyPendingSessionWorkspaceActivation } from "../lib/sessionWorkspaceActivation";
import {
  shouldAutoCompactContext,
  supportsContextAutoCompaction,
  supportsContextCompactionControls,
} from "../lib/autoCompact";
import { resolveSessionCwd } from "@/features/projects/lib/sessionCwdSelection";
import {
  acceptFirstSend,
  prepareExistingFirstSend,
  chooseDeferredWorkspaceSetup,
  cancelDeferredWorkspaceNaming,
  createDeferredWorkspaces,
  provisionPreSendProjectWorkspaces,
  releaseDeferredWorkspaceSend,
  workspaceAttachmentsEqualConfiguration,
  UNRESOLVED_DEFERRED_SEND_ERROR,
  type DeferredWorkspaceSend,
  type WorkspaceNameRequest,
} from "../lib/firstWorkspaceSend";
export type { WorkspaceNameRequest } from "../lib/firstWorkspaceSend";
import { activateSession } from "../lib/sessionActivation";
import { useResolvedAgentModelPicker } from "./useResolvedAgentModelPicker";
import { composeBuilderSendOptions } from "./useBuilderSendInterceptor";
import { moveSessionToProject } from "../stores/chatSessionOperations";
import { acpSetSessionConfigOption } from "@/shared/api/acp";
import { updateSessionProject } from "@/shared/api/acpApi";
import {
  markAgentBuilderSessionPreparationFailed,
  preSeedDraftAgent,
} from "@/features/agents/lib/agentBuilderSession";
import { personaExecutionTarget } from "@/features/agents/lib/personaExecutionTarget";
import { deletePersonaSource } from "@/shared/api/agents";
import type { Persona } from "@/shared/types/agents";
import {
  ensureAgentBuilderSkillDraft,
  hasAgentBuilderSkillDraft,
  isAgentBuilderSkillSendOptions,
} from "../lib/agentBuilderSkill";
import {
  beginModelSelectionIntent,
  clearCurrentModelSelectionIntent,
  getModelSelectionIntent,
  createModelSelectionRequestId,
  isCurrentModelSelectionIntent,
  rollbackToPreviousModel,
  showModelSwitchErrorToast,
  type ApplySessionModelSelection,
  type ModelSelectionApplyOptions,
  type PreferredModelSelection,
} from "../model-selection/modelSelectionIntent";
import {
  collectStrandedComposerText,
  recoverStrandedProviderSession,
  type RecreateSessionForProvider,
} from "../model-selection/strandedProviderRecovery";
import { perfLog } from "@/shared/lib/perfLog";
import { remoteSafeAttachments } from "@/features/chat/lib/attachments";
import type { BerdChatChatSourceSurface } from "@/shared/telemetry/events";
import { isFirstCommittedUserMessage } from "../lib/chatFirstMessage";
import {
  CHAT_SOURCE_SURFACE,
  trackChatMessageSent,
  trackChatSessionStarted,
} from "../lib/chatTelemetry";
import {
  isModelExecutionTarget,
  normalizeSessionExecutionTarget,
  sameSessionExecutionTarget,
  targetFromAgentModelSelection,
  type SessionExecutionTarget,
} from "../lib/sessionExecutionTarget";
import {
  executionTargetFromGooseServeBoundary,
  gooseServeSelectionFromExecutionTarget,
} from "../lib/gooseServeExecutionTarget";

interface UseChatSessionControllerOptions {
  sessionId: string | null;
  isHomeSession?: boolean;
  readOnly?: boolean;
  onMessageAccepted?: (sessionId: string) => void;
  onCreatePersonaRequested?: () => void;
  onWorkspaceNameRequest?: (request: WorkspaceNameRequest) => void;
}

const DRAFT_STORE_UPDATE_DEBOUNCE_MS = 300;
const PENDING_HOME_SESSION_ID = "__home_pending__";
const EMPTY_SKILL_DRAFTS: ChatSkillDraft[] = [];
const EMPTY_ATTACHMENT_DRAFTS: ChatAttachmentDraft[] = [];
const AGENT_BUILDER_MENTION_INVOCATION = /^@agent-builder\s*$/i;
const STEERING_SUPPORTED_AGENT_ID = "goose";
const EMPTY_PROMPT_STATE: { key: string; prompt: string | undefined } = {
  key: "",
  prompt: undefined,
};

function nextPromptState(
  current: { key: string; prompt: string | undefined },
  next: { key: string; prompt: string | undefined },
) {
  return current.key === next.key && current.prompt === next.prompt
    ? current
    : next;
}

function isAgentBuilderMentionOnlyDraft(text: string): boolean {
  return AGENT_BUILDER_MENTION_INVOCATION.test(text.trim());
}

function movePendingHomeQueuedMessages(sessionId: string): string[] {
  const chatState = useChatStore.getState();
  const recordIds = (
    chatState.queuedMessageBySession[PENDING_HOME_SESSION_ID] ?? []
  ).map((record) => record.recordId);
  const movedRecordIds: string[] = [];
  for (const recordId of recordIds) {
    if (
      !useChatStore
        .getState()
        .moveQueuedMessage(PENDING_HOME_SESSION_ID, sessionId, recordId)
    ) {
      break;
    }
    movedRecordIds.push(recordId);
  }
  return movedRecordIds;
}

type SessionCwdProject = Parameters<typeof resolveSessionCwd>[0];
type ProviderCatalogEntries = Parameters<
  typeof resolveAgentProviderCatalogIdStrictFromEntries
>[0];

interface PendingHomeModelSyncArgs {
  sessionId: string;
  nextWireProviderId: string;
  nextProject: SessionCwdProject;
  workspacePath?: string | null;
  homePendingModel: PreferredModelSelection | null;
  homePendingModelProviderId: string;
  selectionRequestId: string;
  previousTarget?: SessionExecutionTarget;
  catalogEntries: ProviderCatalogEntries;
  prepareCurrentSession: (
    wireProviderId: string,
    nextProject?: SessionCwdProject,
    nextWorkspacePath?: string | null,
    requestId?: string,
  ) => Promise<boolean>;
  applySessionModelSelection: ApplySessionModelSelection;
  setGlobalSelectedProvider: (providerId: string) => void;
  recreateSessionForProvider?: RecreateSessionForProvider;
}

async function syncPendingHomeModelSelection({
  sessionId,
  nextWireProviderId,
  nextProject,
  workspacePath,
  homePendingModel,
  homePendingModelProviderId,
  selectionRequestId,
  previousTarget,
  catalogEntries,
  prepareCurrentSession,
  applySessionModelSelection,
  setGlobalSelectedProvider,
  recreateSessionForProvider,
}: PendingHomeModelSyncArgs): Promise<void> {
  try {
    const applied = homePendingModel?.id
      ? await applySessionModelSelection(
          homePendingModelProviderId,
          homePendingModel,
          selectionRequestId,
          {
            nextProject,
            nextWorkspacePath: workspacePath,
          },
        )
      : await prepareCurrentSession(
          nextWireProviderId,
          nextProject,
          workspacePath,
          selectionRequestId,
        );
    const intentStillMatches =
      getModelSelectionIntent(sessionId)?.requestId === selectionRequestId;
    if (!intentStillMatches) {
      return;
    }
    clearCurrentModelSelectionIntent(sessionId, selectionRequestId);
    if (applied && homePendingModel?.source === "explicit") {
      const agentId =
        resolveAgentProviderCatalogIdStrictFromEntries(
          catalogEntries,
          homePendingModelProviderId,
        ) ?? "goose";
      setStoredModelPreference(agentId, {
        modelId: homePendingModel.id,
        modelName: homePendingModel.name,
        providerId: homePendingModelProviderId,
      });
    }
  } catch (error) {
    const selectionStillCurrent = () =>
      getModelSelectionIntent(sessionId)?.requestId === selectionRequestId;
    if (!selectionStillCurrent()) {
      return;
    }

    // A pending Home choice can land here after the real session is born. If
    // its inherited provider is unusable, recreate directly on the UI-owned
    // target. Keep the intent alive across the await so a newer pick can
    // supersede this recovery.
    if (
      await recoverStrandedProviderSession({
        error,
        sessionId,
        providerId: homePendingModel?.id
          ? homePendingModelProviderId
          : nextWireProviderId,
        modelSelection: homePendingModel,
        recreateSessionForProvider,
        isSelectionCurrent: selectionStillCurrent,
        onRecovered: () => {
          if (homePendingModel?.source !== "explicit") {
            return;
          }
          const agentId =
            resolveAgentProviderCatalogIdStrictFromEntries(
              catalogEntries,
              homePendingModelProviderId,
            ) ?? "goose";
          setStoredModelPreference(agentId, {
            modelId: homePendingModel.id,
            modelName: homePendingModel.name,
            providerId: homePendingModelProviderId,
          });
        },
      })
    ) {
      clearCurrentModelSelectionIntent(sessionId, selectionRequestId);
      return;
    }
    if (!selectionStillCurrent()) {
      return;
    }
    clearCurrentModelSelectionIntent(sessionId, selectionRequestId);
    console.error("Failed to sync pending Home state:", error);
    if (!homePendingModel?.id) {
      replaceSessionTargetAfterDispatch(sessionId, previousTarget);
      if (previousTarget) {
        setGlobalSelectedProvider(previousTarget.harnessId);
      }
      showModelSwitchErrorToast({
        modelName: nextWireProviderId,
        fallbackModelName:
          gooseServeSelectionFromExecutionTarget(previousTarget).providerId ??
          null,
      });
      return;
    }
    rollbackToPreviousModel({
      sessionId,
      failedModelName: homePendingModel.name,
      previousTarget,
      applySessionModelSelection,
      prepareSelectedProvider: (providerId, options) =>
        prepareCurrentSession(
          providerId,
          options?.nextProject,
          options?.nextWorkspacePath,
          options?.requestId,
        ),
      setGlobalSelectedProvider,
      options: {
        nextProject,
        nextWorkspacePath: workspacePath,
      },
      restoreErrorMessage:
        "Failed to restore previous model after Home model sync failure:",
    });
  }
}

export function useChatSessionController({
  sessionId,
  isHomeSession,
  readOnly = false,
  onMessageAccepted,
  onCreatePersonaRequested,
  onWorkspaceNameRequest,
}: UseChatSessionControllerOptions) {
  const stateSessionId = sessionId ?? PENDING_HOME_SESSION_ID;
  const {
    providers,
    providersLoading,
    selectedProvider: globalSelectedProvider,
    setSelectedProvider: setGlobalSelectedProvider,
  } = useProviderSelection();
  const personas = useAgentStore(selectPersonas);
  const session = useChatSessionStore((s) =>
    sessionId
      ? s.sessions.find((candidate) => candidate.id === sessionId)
      : undefined,
  );
  const activeWorkspace = useChatSessionStore((s) =>
    sessionId ? s.activeWorkspaceBySession[sessionId] : undefined,
  );
  const clearActiveWorkspace = useChatSessionStore(
    (s) => s.clearActiveWorkspace,
  );
  const projects = useProjectStore(selectProjects);
  const projectsLoading = useProjectStore((s) => s.loading);
  const catalogEntries = useProviderCatalogStore((s) => s.entries);
  const catalogLoaded = useProviderCatalogStore((s) => s.loaded);
  const [pendingPersonaId, setPendingPersonaId] = useState<string | null>();
  const [pendingProjectId, setPendingProjectId] = useState<string | null>();
  const [pendingRemoteHost, setPendingRemoteHost] = useState<string | null>();
  const remoteSendInFlightRef = useRef(false);
  const [pendingRemoteDir, setPendingRemoteDir] = useState<string | null>();
  const [pendingExecutionTarget, setPendingExecutionTarget] =
    useState<SessionExecutionTarget | null>();
  const [pendingModelSelection, setPendingModelSelection] =
    useState<PreferredModelSelection | null>();
  const preSendWorkspaceOperationRef = useRef(0);
  const [preSendWorkspaceSetup, setPreSendWorkspaceSetup] = useState<{
    sessionId: string;
    status: "choice" | "naming" | "creating" | "selected";
    startupName?: string | null;
    error?: string;
  } | null>(null);
  const pendingDefaultReasoningEffortBySessionRef = useRef<
    Record<string, string>
  >({});
  const reasoningEffortDefaultSaveQueueRef = useRef<Promise<void>>(
    Promise.resolve(),
  );
  const reasoningEffortRefreshKeyBySessionRef = useRef<Record<string, string>>(
    {},
  );
  const sessionLocalMessageCount = useChatStore((s) =>
    sessionId
      ? (s.messagesBySession[sessionId]?.filter(
          (message) => message.role !== "system",
        ).length ?? 0)
      : 0,
  );
  const sessionHasStarted = session
    ? hasSessionStarted(session, sessionLocalMessageCount)
    : false;
  const remoteSshSessionsExperimentEnabled =
    useExperiment(REMOTE_SSH_SESSIONS_EXPERIMENT_ID)?.enabled === true;
  // A session's backend is fixed once its backend session exists, so remote
  // host selection is offered pre-start only (home/draft/pending states);
  // started sessions merely display their host.
  const remoteHostSelectionEnabled =
    remoteSshSessionsExperimentEnabled && !readOnly && !sessionHasStarted;
  const selectedRemoteHost =
    pendingRemoteHost !== undefined
      ? pendingRemoteHost
      : (session?.remoteHost ?? null);
  const selectedRemoteDir =
    pendingRemoteDir !== undefined
      ? pendingRemoteDir
      : session?.remoteHost
        ? (session.workingDir ?? null)
        : null;
  const pendingDraftValue = useChatStore(
    isHomeSession
      ? (s) => s.draftsBySession[PENDING_HOME_SESSION_ID] ?? ""
      : () => "",
  );
  const pendingSkillDrafts = useChatStore(
    isHomeSession
      ? (s) =>
          s.skillDraftsBySession[PENDING_HOME_SESSION_ID] ?? EMPTY_SKILL_DRAFTS
      : () => EMPTY_SKILL_DRAFTS,
  );
  const pendingDraftAttachments = useChatStore(
    isHomeSession
      ? (s) =>
          s.draftAttachmentsBySession[PENDING_HOME_SESSION_ID] ??
          EMPTY_ATTACHMENT_DRAFTS
      : () => EMPTY_ATTACHMENT_DRAFTS,
  );
  const pendingQueuedMessage = useChatStore(
    isHomeSession
      ? (s) => s.queuedMessageBySession[PENDING_HOME_SESSION_ID]?.[0] ?? null
      : () => null,
  );
  const effectiveProjectId =
    pendingProjectId !== undefined
      ? pendingProjectId
      : (session?.projectId ?? null);
  const storedProject = useProjectStore((s) =>
    effectiveProjectId
      ? s.projects.find((candidate) => candidate.id === effectiveProjectId)
      : undefined,
  );
  const project = storedProject ?? null;
  const { autoCompactThreshold, isHydrated: isAutoCompactThresholdHydrated } =
    useAutoCompactPreferences();
  const hasContextUsageSnapshot = useChatStore(
    (s) => s.sessionStateById[stateSessionId]?.hasUsageSnapshot ?? false,
  );
  const selectedProvider =
    pendingExecutionTarget?.harnessId ??
    session?.executionTarget?.harnessId ??
    globalSelectedProvider;
  const selectedPersonaId =
    pendingPersonaId !== undefined
      ? pendingPersonaId
      : (session?.personaId ?? null);
  const [selectedPersonaSnapshot, setSelectedPersonaSnapshot] =
    useState<Persona | null>(null);
  const liveSelectedPersona = personas.find(
    (persona) => persona.id === selectedPersonaId,
  );
  const nextSelectedPersonaSnapshot = !selectedPersonaId
    ? null
    : (liveSelectedPersona ??
      (selectedPersonaSnapshot?.id === selectedPersonaId
        ? selectedPersonaSnapshot
        : null));
  if (selectedPersonaSnapshot !== nextSelectedPersonaSnapshot) {
    setSelectedPersonaSnapshot(nextSelectedPersonaSnapshot);
  }
  const selectedPersona =
    liveSelectedPersona ?? nextSelectedPersonaSnapshot ?? undefined;
  const displayedPersonas = useMemo(() => {
    if (
      selectedPersona &&
      !personas.some((persona) => persona.id === selectedPersona.id)
    ) {
      return [selectedPersona, ...personas];
    }
    return personas;
  }, [personas, selectedPersona]);
  const workspaceRepository = useWorkspaceRepository();
  const chatWorkspaceSet = useMemo(
    () =>
      workspaceRepository.chatWorkspaces(session, {
        activePath: activeWorkspace?.path,
      }),
    [activeWorkspace?.path, session, workspaceRepository],
  );
  const sessionWorkspacePath = chatWorkspaceSet.primary?.path;
  const sessionCwd =
    sessionWorkspacePath ?? resolveProjectDefaultArtifactRoot(project);
  const projectDefaultArtifactRoot = useMemo(
    () => resolveProjectDefaultArtifactRoot(project),
    [project],
  );
  const projectMetadataPending = Boolean(
    effectiveProjectId && !projectDefaultArtifactRoot && projectsLoading,
  );
  const sessionArtifactCwd = useMemo(
    () => sessionCwd?.trim() || null,
    [sessionCwd],
  );
  const availableProjects = useMemo(
    () =>
      [...projects]
        .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
        .map((projectInfo) => ({
          id: projectInfo.id,
          name: projectInfo.name,
          workingDirs: projectInfo.workingDirs,
          icon: projectInfo.icon,
          color: projectInfo.color,
        })),
    [projects],
  );
  const includedWorkspacesPrompt =
    workspaceRepository.mode === "multi"
      ? formatIncludedWorkspacesPrompt(session)
      : undefined;
  const includedWorkspacePaths = useMemo(
    () =>
      workspaceRepository.mode === "multi"
        ? chatWorkspaceSet.workspaces.map((workspace) => workspace.path)
        : [],
    [chatWorkspaceSet.workspaces, workspaceRepository.mode],
  );
  const workspaceContextKey = useMemo(
    () => includedWorkspacePaths.join("\0"),
    [includedWorkspacePaths],
  );
  const skillProviderId = useMemo(
    () =>
      resolveSelectedAgentId({
        catalogEntries,
        catalogLoaded,
        selectedProvider,
      }),
    [catalogEntries, catalogLoaded, selectedProvider],
  );
  const skillsCatalogKey = useMemo(
    () => `${skillProviderId}\0${workspaceContextKey}`,
    [skillProviderId, workspaceContextKey],
  );
  const hasIncludedWorkspacePaths = includedWorkspacePaths.length > 0;
  // Optional so tests and provider-less mounts fall back to direct fetches;
  // with a client, skill/workspace reads share react-query entries with the
  // other chat surfaces that load the same data on mount.
  const queryClient = useContext(QueryClientContext);
  const [workspaceInstructionsState, setWorkspaceInstructionsState] =
    useState(EMPTY_PROMPT_STATE);
  const [availableSkillsCatalogState, setAvailableSkillsCatalogState] =
    useState(EMPTY_PROMPT_STATE);
  const [appSkillsCatalogState, setAppSkillsCatalogState] =
    useState(EMPTY_PROMPT_STATE);
  const workspaceInstructionsReady =
    !hasIncludedWorkspacePaths ||
    workspaceInstructionsState.key === workspaceContextKey;
  const appSkillsCatalogReady = appSkillsCatalogState.key === "app";
  const availableSkillsCatalogReady =
    !hasIncludedWorkspacePaths ||
    availableSkillsCatalogState.key === skillsCatalogKey;
  const workspaceContextReady =
    workspaceInstructionsReady &&
    appSkillsCatalogReady &&
    availableSkillsCatalogReady;
  const skillProjectDirs =
    workspaceRepository.mode === "multi" ? includedWorkspacePaths : undefined;
  const fileMentionProjectDirs =
    workspaceRepository.mode === "multi"
      ? includedWorkspacePaths
      : sessionCwd
        ? [sessionCwd]
        : undefined;
  const workspaceInstructionsPrompt =
    workspaceInstructionsState.key === workspaceContextKey
      ? workspaceInstructionsState.prompt
      : undefined;
  const availableSkillsCatalogPrompt =
    availableSkillsCatalogState.key === skillsCatalogKey
      ? availableSkillsCatalogState.prompt
      : undefined;
  const appSkillsCatalogPrompt =
    appSkillsCatalogState.key === "app"
      ? appSkillsCatalogState.prompt
      : undefined;
  const artifactFolderInstructions = useMemo(() => {
    if (project) return undefined;
    return formatArtifactFolderInstructions(sessionArtifactCwd);
  }, [project, sessionArtifactCwd]);
  useEffect(() => {
    let cancelled = false;

    if (includedWorkspacePaths.length === 0) {
      setWorkspaceInstructionsState((current) =>
        nextPromptState(current, {
          key: workspaceContextKey,
          prompt: undefined,
        }),
      );
      return;
    }

    void loadWorkspaceInstructionFiles(includedWorkspacePaths, { queryClient })
      .then((instructionFiles) => {
        if (cancelled) return;
        setWorkspaceInstructionsState((current) =>
          nextPromptState(current, {
            key: workspaceContextKey,
            prompt: formatWorkspaceInstructionsPrompt(instructionFiles),
          }),
        );
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Failed to load workspace instructions:", error);
        setWorkspaceInstructionsState((current) =>
          nextPromptState(current, {
            key: workspaceContextKey,
            prompt: undefined,
          }),
        );
      });

    return () => {
      cancelled = true;
    };
  }, [includedWorkspacePaths, queryClient, workspaceContextKey]);
  // Both catalog effects below subscribe to skills-changed and reload fresh,
  // mirroring useMentionHandlers: the mention/search consumers share these
  // query keys and their fresh reloads cancel any in-flight fetch on them, so
  // without a listener a mount fetch cancelled mid-flight would reject into
  // the catch and leave the session's catalog missing until remount. The
  // requestId guard drops that superseded rejection (and any late settle) —
  // listeners run synchronously in the event sweep, so the guard is bumped
  // before the cancelled fetch's rejection lands — while this effect's own
  // fresh reload coalesces with the siblings' onto one post-event refetch.
  useEffect(() => {
    let cancelled = false;
    let requestId = 0;

    const loadAppSkillsCatalog = (options: { fresh?: boolean } = {}) => {
      const currentRequestId = requestId + 1;
      requestId = currentRequestId;

      void fetchBerdAppSkills(queryClient, options)
        .then((skills) => {
          if (cancelled || currentRequestId !== requestId) return;
          setAppSkillsCatalogState((current) =>
            nextPromptState(current, {
              key: "app",
              prompt: formatAvailableSkillsCatalogPrompt(skills),
            }),
          );
        })
        .catch((error) => {
          if (cancelled || currentRequestId !== requestId) return;
          console.error("Failed to load Berd app skills catalog:", error);
          setAppSkillsCatalogState((current) =>
            nextPromptState(current, {
              key: "app",
              prompt: undefined,
            }),
          );
        });
    };

    loadAppSkillsCatalog();
    const cleanup = listenSkillsChanged(() =>
      loadAppSkillsCatalog({ fresh: true }),
    );

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [queryClient]);
  useEffect(() => {
    let cancelled = false;
    let requestId = 0;

    if (!hasIncludedWorkspacePaths) {
      setAvailableSkillsCatalogState((current) =>
        nextPromptState(current, {
          key: skillsCatalogKey,
          prompt: undefined,
        }),
      );
      return;
    }

    const loadAvailableSkillsCatalog = (options: { fresh?: boolean } = {}) => {
      const currentRequestId = requestId + 1;
      requestId = currentRequestId;

      // The app-skills catalog effect above owns the Berd app skills; skip
      // them here instead of fetching a copy just to filter it out.
      void fetchSkillsList(queryClient, includedWorkspacePaths, {
        providerId: skillProviderId,
        includeAppSkills: false,
        fresh: options.fresh,
      })
        .then((skills) => {
          if (cancelled || currentRequestId !== requestId) return;
          setAvailableSkillsCatalogState((current) =>
            nextPromptState(current, {
              key: skillsCatalogKey,
              prompt: formatAvailableSkillsCatalogPrompt(skills),
            }),
          );
        })
        .catch((error) => {
          if (cancelled || currentRequestId !== requestId) return;
          console.error("Failed to load available skills catalog:", error);
          setAvailableSkillsCatalogState((current) =>
            nextPromptState(current, {
              key: skillsCatalogKey,
              prompt: undefined,
            }),
          );
        });
    };

    loadAvailableSkillsCatalog();
    const cleanup = listenSkillsChanged(() =>
      loadAvailableSkillsCatalog({ fresh: true }),
    );

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [
    hasIncludedWorkspacePaths,
    includedWorkspacePaths,
    queryClient,
    skillProviderId,
    skillsCatalogKey,
  ]);
  const effectiveSystemPrompt = useMemo(
    () =>
      composeSystemPrompt(
        formatPersonaSystemPrompt(selectedPersona),
        includedWorkspacesPrompt,
        workspaceInstructionsPrompt,
        appSkillsCatalogPrompt,
        availableSkillsCatalogPrompt,
      ),
    [
      selectedPersona,
      includedWorkspacesPrompt,
      workspaceInstructionsPrompt,
      appSkillsCatalogPrompt,
      availableSkillsCatalogPrompt,
    ],
  );
  const skillProviderCapabilities = useMemo(
    () => getSkillProviderCapabilities(skillProviderId),
    [skillProviderId],
  );

  // Remote sessions carry a workingDir on the remote host's filesystem;
  // local path resolution would rewrite it to a local artifacts dir. Pass it
  // through verbatim for them (mirrors sessionActivation/queuedSessionSend).
  const resolveCwdForSession = useCallback(
    async (
      targetSessionId: string | null | undefined,
      nextProject: SessionCwdProject,
      nextWorkspacePath: string | null | undefined,
    ) => {
      const liveSession = targetSessionId
        ? useChatSessionStore.getState().getSession(targetSessionId)
        : undefined;
      if (
        liveSession &&
        isRemoteSession(liveSession) &&
        liveSession.workingDir
      ) {
        return liveSession.workingDir;
      }
      return resolveSessionCwd(nextProject, nextWorkspacePath);
    },
    [],
  );

  const prepareCurrentSession = useCallback(
    async (
      providerId: string,
      nextProject = project,
      nextWorkspacePath: string | null | undefined = sessionWorkspacePath,
      requestId?: string,
    ) => {
      if (!sessionId) {
        return false;
      }
      const workingDir = await resolveCwdForSession(
        sessionId,
        nextProject,
        nextWorkspacePath,
      );
      if (requestId && !isCurrentModelSelectionIntent(sessionId, requestId)) {
        return false;
      }
      const target = executionTargetFromGooseServeBoundary({ providerId });
      const result = await transitionSessionTarget({
        sessionId,
        target,
        workingDir,
        requestId,
      });
      if (!result.applied) {
        return result.applied;
      }
      if (requestId && !isCurrentModelSelectionIntent(sessionId, requestId)) {
        return false;
      }

      return true;
    },
    [project, sessionId, sessionWorkspacePath, resolveCwdForSession],
  );
  const prepareCurrentSessionTarget = useCallback(
    async (
      requestedTarget: SessionExecutionTarget,
      nextProject = project,
      nextWorkspacePath: string | null | undefined = sessionWorkspacePath,
    ) => {
      if (!sessionId) {
        return false;
      }
      const sessionStore = useChatSessionStore.getState();
      const liveSession = sessionStore.getSession(sessionId);
      const selectionIntent = getModelSelectionIntent(sessionId);
      let targetToApply: {
        target: SessionExecutionTarget;
        requestId?: string;
      } = { target: requestedTarget };
      if (liveSession?.executionTarget) {
        targetToApply = { target: liveSession.executionTarget };
      }
      if (selectionIntent) {
        targetToApply = {
          target: selectionIntent.target,
          requestId: selectionIntent.requestId,
        };
      }
      const wireProviderId = gooseServeSelectionFromExecutionTarget(
        targetToApply.target,
      ).providerId;
      if (!wireProviderId) return false;
      const workingDir = await resolveCwdForSession(
        sessionId,
        nextProject,
        nextWorkspacePath,
      );
      if (!targetToApply.target.modelId) {
        const result = await transitionSessionTarget({
          sessionId,
          target: targetToApply.target,
          workingDir,
          requestId: targetToApply.requestId,
        });
        return result.applied;
      }

      const modelStillCurrent = () => {
        const liveStore = useChatSessionStore.getState();
        const liveIntent = getModelSelectionIntent(sessionId);
        if (targetToApply.requestId) {
          if (liveIntent) {
            return liveIntent.requestId === targetToApply.requestId;
          }
          const latestSession = liveStore.getSession(sessionId);
          return sameSessionExecutionTarget(
            latestSession?.executionTarget,
            targetToApply.target,
          );
        }
        if (liveIntent) {
          return false;
        }
        const latestSession = liveStore.getSession(sessionId);
        return sameSessionExecutionTarget(
          latestSession?.executionTarget,
          targetToApply.target,
        );
      };
      if (!modelStillCurrent()) {
        return false;
      }
      const result = await transitionSessionTarget({
        sessionId,
        target: targetToApply.target,
        workingDir,
        requestId: targetToApply.requestId,
      });
      if (!result.applied) {
        return result.applied;
      }
      if (!modelStillCurrent()) {
        return false;
      }
      delete pendingDefaultReasoningEffortBySessionRef.current[sessionId];
      return true;
    },
    [project, sessionWorkspacePath, sessionId, resolveCwdForSession],
  );
  const prepareSelectedProvider = useCallback(
    (wireProviderId: string, options?: ModelSelectionApplyOptions) =>
      prepareCurrentSession(
        wireProviderId,
        options?.nextProject ?? project,
        options?.nextWorkspacePath ?? sessionWorkspacePath,
        options?.requestId,
      ),
    [prepareCurrentSession, project, sessionWorkspacePath],
  );

  const applySessionModelSelection = useCallback<ApplySessionModelSelection>(
    async (
      modelProviderId: string,
      modelSelection: PreferredModelSelection,
      requestId: string,
      options?: ModelSelectionApplyOptions,
    ) => {
      if (!sessionId) {
        return false;
      }
      // Bail before local async work if a newer selection already owns the
      // session.
      if (!isCurrentModelSelectionIntent(sessionId, requestId)) {
        return false;
      }
      const intent = getModelSelectionIntent(sessionId);
      if (
        !intent ||
        !isModelExecutionTarget(intent.target) ||
        intent.requestId !== requestId ||
        intent.target.modelId !== modelSelection.id ||
        gooseServeSelectionFromExecutionTarget(intent.target).providerId !==
          modelProviderId
      ) {
        return false;
      }
      const target = intent.target;
      const workingDir = await resolveCwdForSession(
        sessionId,
        options?.nextProject ?? project,
        options?.nextWorkspacePath ?? sessionWorkspacePath,
      );
      // resolveSessionCwd can yield while the user changes models; do not send
      // a stale provider/model pair to ACP after that happens.
      if (!isCurrentModelSelectionIntent(sessionId, requestId)) {
        return false;
      }
      const result = await transitionSessionTarget({
        sessionId,
        target,
        workingDir,
        requestId,
      });
      // The coordinator owns latest-only work. A newer request may
      // have superseded this one while ACP was being prepared, so only the
      // owning intent may continue with caller-specific preference updates.
      if (!isCurrentModelSelectionIntent(sessionId, requestId)) {
        return false;
      }
      if (!result.applied) {
        return false;
      }
      let effectiveTarget = result.resolvedTarget ?? target;
      let configOptionsSnapshot = result.configOptionsSnapshot;
      if (isHomeSession && !configOptionsSnapshot?.reasoningEffort) {
        const refreshResult = await transitionSessionTarget({
          sessionId,
          target: effectiveTarget,
          workingDir,
          requireReasoningEffort: true,
          requestId,
        });
        if (!isCurrentModelSelectionIntent(sessionId, requestId)) {
          return false;
        }
        if (refreshResult.applied) {
          effectiveTarget = refreshResult.resolvedTarget ?? effectiveTarget;
          configOptionsSnapshot = refreshResult.configOptionsSnapshot;
        }
      }
      delete pendingDefaultReasoningEffortBySessionRef.current[sessionId];
      return true;
    },
    [
      isHomeSession,
      project,
      sessionId,
      sessionWorkspacePath,
      resolveCwdForSession,
    ],
  );

  // Escape hatch for the "Provider not set" trap. When an in-place provider or
  // model switch fails because the session's live provider never constructed,
  // the backend's switch handlers reject before they can install the target
  // provider — they read the current (dead) provider first. Rather than roll
  // back onto the corpse, recreate an empty session directly on the target
  // provider: newSession installs the provider at birth, bypassing the
  // read-current gate, so the fresh session is born healthy. Navigation follows
  // the store's active session automatically. Resolves true when it navigated
  // onto the fresh session, false when a newer pick superseded it mid-flight —
  // the caller uses this to persist the recovered model preference only for the
  // selection that actually won.
  const recreateSessionForProvider = useCallback(
    async (
      providerId: string,
      modelSelection?: PreferredModelSelection | null,
      isSelectionCurrent?: () => boolean,
    ): Promise<boolean> => {
      const store = useChatSessionStore.getState();
      const current = sessionId ? store.getSession(sessionId) : undefined;
      const workingDir = await resolveCwdForSession(
        sessionId,
        project,
        activeWorkspace?.path ?? current?.workingDir ?? session?.workingDir,
      );
      const modelId =
        modelSelection?.id &&
        modelSelection.id !== "current" &&
        modelSelection.id !== "default"
          ? modelSelection.id
          : undefined;
      // Capture the user's typed-but-unsent text (failed prompts + composer
      // draft) before creating the fresh session: recovery now also covers
      // sessions where a prompt failed to send on the dead provider, and that
      // text must survive the hop rather than be archived with the corpse.
      const strandedComposerText = sessionId
        ? collectStrandedComposerText(sessionId)
        : "";
      const strandedSessionId = current?.id ?? sessionId;
      const strandedComposerAttachments = strandedSessionId
        ? useChatStore.getState().draftAttachmentsBySession[strandedSessionId]
        : undefined;
      const created = await store.createSession({
        title: current?.title,
        projectId: current?.projectId ?? undefined,
        personaId: current?.personaId,
        executionTarget: executionTargetFromGooseServeBoundary({
          providerId,
          modelId,
          modelName: modelId ? (modelSelection?.name ?? undefined) : undefined,
        }),
        workingDir,
        // Force provider construction at session birth so the fresh session
        // cannot re-enter the deferred/broken-provider bootstrap that stranded
        // the old one.
        deferProviderSetup: false,
      });

      // The caller's version guard ran before this detached recreate began, but
      // createSession just awaited. If a newer provider/model pick superseded
      // this selection during that window, do not navigate onto a stale target
      // — the newer pick owns activation. Archive the empty session we just
      // created so it does not orphan (best-effort), then bail before touching
      // the active session or the stranded corpse (the newer recreate retires
      // that one).
      if (isSelectionCurrent && !isSelectionCurrent()) {
        try {
          await store.archiveSession(created.id);
        } catch (error) {
          console.error(
            "Failed to archive superseded recreated session:",
            error,
          );
        }
        return false;
      }

      // Seed the recovered draft into the fresh session's composer before
      // navigating so the user lands with their prompt ready to resend on the
      // healthy provider.
      if (strandedComposerText) {
        useChatStore.getState().setDraft(created.id, strandedComposerText);
      }
      if (strandedComposerAttachments?.length) {
        useChatStore
          .getState()
          .setDraftAttachments(created.id, strandedComposerAttachments);
      }

      activateSession(created.id);

      // Retire the stranded corpse now that we've migrated off it. Recovery
      // only routes sessions with no committed backend turns and no assistant
      // content here, and any typed-but-failed prompt text was just carried
      // into the new composer, so nothing is lost — but left in place
      // the dead session lingers in the list, re-triggers the same trap when
      // re-entered, and accumulates a new empty each time the user retries.
      // Archive rather than drop locally: the session exists on the backend, so
      // a local removal would reappear on the next loadSessions(). Best-effort —
      // recovery already succeeded, so a failed cleanup must not surface as a
      // recovery failure.
      if (strandedSessionId && strandedSessionId !== created.id) {
        try {
          await store.archiveSession(strandedSessionId);
        } catch (error) {
          console.error(
            "Failed to archive stranded session after provider recovery:",
            error,
          );
        }
      }

      return true;
    },
    [
      activeWorkspace?.path,
      project,
      session?.workingDir,
      sessionId,
      resolveCwdForSession,
    ],
  );

  const prevProjectIdRef = useRef(session?.projectId);
  useEffect(() => {
    if (!sessionId) {
      return;
    }
    const previousProjectId = prevProjectIdRef.current;
    prevProjectIdRef.current = session?.projectId;
    if (
      previousProjectId !== undefined &&
      previousProjectId !== session?.projectId
    ) {
      clearActiveWorkspace(sessionId);
    }
  }, [clearActiveWorkspace, session?.projectId, sessionId]);

  const {
    selectedAgentId,
    pickerAgents,
    availableModels,
    getModelsForAgent,
    modelsLoading,
    modelStatusMessage,
    handleProviderChange,
    handleModelChange,
    handlePickerOpen,
    effectiveModelSelection,
  } = useResolvedAgentModelPicker({
    providers,
    selectedProvider,
    sessionId,
    session,
    sessionHasStarted,
    pendingModelSelection,
    setPendingModelSelection,
    setPendingExecutionTarget,
    setGlobalSelectedProvider,
    prepareSelectedProvider,
    applySessionModelSelection,
    recreateSessionForProvider,
  });

  const refreshMissingReasoningEffort = useCallback(async () => {
    if (!sessionId || readOnly || session?.reasoningEffort) {
      return;
    }

    const localTargetAtStart = session?.executionTarget;
    const refreshTarget =
      localTargetAtStart && isModelExecutionTarget(localTargetAtStart)
        ? localTargetAtStart
        : session?.executionTargetSource !== "ui" &&
            effectiveModelSelection?.id &&
            effectiveModelSelection.modelProviderId
          ? targetFromAgentModelSelection(selectedAgentId, {
              modelProviderId: effectiveModelSelection.modelProviderId,
              modelId: effectiveModelSelection.id,
              modelName: effectiveModelSelection.name,
            })
          : null;
    if (!refreshTarget || !isModelExecutionTarget(refreshTarget)) {
      return;
    }

    const refreshKey = [
      refreshTarget.harnessId,
      refreshTarget.modelProviderId,
      refreshTarget.modelId,
      session?.workingDir ?? activeWorkspace?.path ?? "",
    ].join("\u0000");
    if (
      reasoningEffortRefreshKeyBySessionRef.current[sessionId] === refreshKey
    ) {
      return;
    }
    reasoningEffortRefreshKeyBySessionRef.current[sessionId] = refreshKey;

    try {
      const workingDir = await resolveCwdForSession(
        sessionId,
        project,
        activeWorkspace?.path ?? session?.workingDir,
      );
      const liveSessionBeforeRefresh = useChatSessionStore
        .getState()
        .getSession(sessionId);
      if (
        !liveSessionBeforeRefresh ||
        liveSessionBeforeRefresh.reasoningEffort ||
        getModelSelectionIntent(sessionId) ||
        !sameSessionExecutionTarget(
          liveSessionBeforeRefresh.executionTarget,
          localTargetAtStart,
        )
      ) {
        return;
      }
      await transitionSessionTarget({
        sessionId,
        target: refreshTarget,
        workingDir,
        requireReasoningEffort: true,
      });
    } catch (error) {
      if (
        reasoningEffortRefreshKeyBySessionRef.current[sessionId] === refreshKey
      ) {
        delete reasoningEffortRefreshKeyBySessionRef.current[sessionId];
      }
      console.error("Failed to refresh reasoning effort config:", error);
    }
  }, [
    activeWorkspace?.path,
    effectiveModelSelection?.id,
    effectiveModelSelection?.modelProviderId,
    effectiveModelSelection?.name,
    project,
    readOnly,
    selectedAgentId,
    session?.executionTarget,
    session?.executionTargetSource,
    session?.reasoningEffort,
    session?.workingDir,
    sessionId,
    resolveCwdForSession,
  ]);

  const handlePickerOpenWithReasoningRefresh = useCallback(() => {
    handlePickerOpen();
    void refreshMissingReasoningEffort();
  }, [handlePickerOpen, refreshMissingReasoningEffort]);

  const resolvePersonaTarget = useCallback(
    (persona: Persona) =>
      personaExecutionTarget(persona, {
        providers,
        models: getModelsForAgent("goose"),
        getModelsForHarness: getModelsForAgent,
        catalogEntries,
      }),
    [catalogEntries, getModelsForAgent, providers],
  );
  const prepareSessionForCurrentSelection = useCallback(
    async (
      _personaId?: string,
      sessionSelection?: ChatSendOptions["sessionSelection"],
      sessionSelectionToken?: ChatSendOptions["sessionSelectionToken"],
    ) => {
      const activatedWorkspacePath =
        await applyPendingSessionWorkspaceActivation(stateSessionId, {
          allowRunning: true,
        });
      const sessionStore = useChatSessionStore.getState();
      const liveSession = sessionStore.getSession(stateSessionId);
      const preparationWorkspacePath =
        activatedWorkspacePath ??
        sessionStore.activeWorkspaceBySession[stateSessionId]?.path ??
        liveSession?.workingDir;
      const target = sessionSelection ?? liveSession?.executionTarget;
      if (!target) {
        return false;
      }
      if (
        sessionSelection &&
        !sessionSelectionToken &&
        !sameSessionExecutionTarget(liveSession?.executionTarget, target)
      ) {
        return false;
      }
      if (sessionSelection) {
        const selectionIsCurrent = () =>
          sessionSelectionToken !== undefined ||
          sameSessionExecutionTarget(
            useChatSessionStore.getState().getSession(stateSessionId)
              ?.executionTarget,
            sessionSelection,
          );
        const workingDir = await resolveCwdForSession(
          stateSessionId,
          project,
          preparationWorkspacePath,
        );
        if (!selectionIsCurrent()) {
          return false;
        }
        const result = await transitionSessionTarget({
          sessionId: stateSessionId,
          target: sessionSelection,
          workingDir,
          dispatchToken: sessionSelectionToken,
        });
        if (!result.applied || !selectionIsCurrent()) {
          return false;
        }
        return true;
      }
      return prepareCurrentSessionTarget(
        target,
        project,
        preparationWorkspacePath,
      );
    },
    [
      prepareCurrentSessionTarget,
      project,
      stateSessionId,
      resolveCwdForSession,
    ],
  );
  const supportsSteering = selectedAgentId === STEERING_SUPPORTED_AGENT_ID;

  const prevWorkspaceRef = useRef(activeWorkspace);
  useEffect(() => {
    const previousWorkspace = prevWorkspaceRef.current;
    if (
      !sessionId ||
      !activeWorkspace ||
      !selectedProvider ||
      activeWorkspace === previousWorkspace
    ) {
      return;
    }
    prevWorkspaceRef.current = activeWorkspace;
    if (previousWorkspace?.path === activeWorkspace.path) {
      return;
    }
    const target = useChatSessionStore
      .getState()
      .getSession(sessionId)?.executionTarget;
    if (!target) {
      return;
    }
    void prepareCurrentSessionTarget(
      target,
      project,
      activeWorkspace?.path,
    ).catch((error) => {
      console.error("Failed to prepare ACP session:", error);
    });
  }, [
    activeWorkspace,
    prepareCurrentSessionTarget,
    project,
    selectedProvider,
    sessionId,
  ]);

  const handleProviderChangeWithContextReset = useCallback(
    (providerId: string) => {
      if (providerId === selectedProvider) {
        return;
      }

      if (sessionId) {
        delete pendingDefaultReasoningEffortBySessionRef.current[sessionId];
      }
      useChatStore.getState().resetTokenState(stateSessionId);
      handleProviderChange(providerId);
    },
    [handleProviderChange, selectedProvider, sessionId, stateSessionId],
  );

  const handleModelChangeWithContextReset = useCallback(
    (modelId: string, model?: ModelOption) => {
      const nextModelProviderId = model?.providerId;
      if (
        modelId === effectiveModelSelection?.id &&
        (!nextModelProviderId ||
          nextModelProviderId === effectiveModelSelection?.modelProviderId)
      ) {
        return;
      }
      if (sessionId) {
        delete pendingDefaultReasoningEffortBySessionRef.current[sessionId];
      }
      useChatStore.getState().resetTokenState(stateSessionId);
      handleModelChange(modelId, model);
    },
    [
      effectiveModelSelection?.id,
      effectiveModelSelection?.modelProviderId,
      handleModelChange,
      sessionId,
      stateSessionId,
    ],
  );

  useEffect(() => {
    if (sessionId && !session?.reasoningEffort) {
      delete pendingDefaultReasoningEffortBySessionRef.current[sessionId];
    }
  }, [session?.reasoningEffort, sessionId]);

  const handleReasoningEffortChange = useCallback(
    (value: string) => {
      if (!sessionId || !session?.reasoningEffort) {
        return;
      }
      const current = session.reasoningEffort;
      if (current.currentValue === value) {
        return;
      }

      useChatSessionStore.getState().patchSession(sessionId, {
        reasoningEffort: {
          ...current,
          currentValue: value,
        },
      });
      if (!sessionHasStarted) {
        pendingDefaultReasoningEffortBySessionRef.current[sessionId] = value;
      }

      const targetAtRequest = session.executionTarget;
      const { providerId, modelId } =
        gooseServeSelectionFromExecutionTarget(targetAtRequest);
      void acpSetSessionConfigOption(sessionId, current.configId, value, {
        providerId,
        modelId,
        reasoningEffortValue: value,
      }).catch((error) => {
        const liveSession = useChatSessionStore
          .getState()
          .getSession(sessionId);
        if (
          !sameSessionExecutionTarget(
            liveSession?.executionTarget,
            targetAtRequest,
          ) ||
          liveSession?.reasoningEffort?.currentValue !== value
        ) {
          return;
        }
        console.error("Failed to set reasoning effort:", error);
        if (
          pendingDefaultReasoningEffortBySessionRef.current[sessionId] === value
        ) {
          delete pendingDefaultReasoningEffortBySessionRef.current[sessionId];
        }
        useChatSessionStore.getState().patchSession(sessionId, {
          reasoningEffort: current,
        });
      });
    },
    [
      session?.executionTarget,
      session?.reasoningEffort,
      sessionHasStarted,
      sessionId,
    ],
  );

  const handleProjectChange = useCallback(
    (projectId: string | null) => {
      if (!sessionId) {
        setPendingProjectId(projectId);
        return;
      }
      void moveSessionToProject(sessionId, projectId).catch((error) => {
        console.error("Failed to move session to project:", error);
      });
    },
    [sessionId],
  );

  const handleRemoteHostChange = useCallback(
    (host: string | null) => {
      setPendingRemoteHost(host);
      // A chosen directory belongs to one host, so any host change resets it.
      setPendingRemoteDir(undefined);
      if (host) {
        const chatStore = useChatStore.getState();
        chatStore.setDraftAttachments(
          stateSessionId,
          remoteSafeAttachments(
            chatStore.draftAttachmentsBySession[stateSessionId],
          ) ?? [],
        );
      }
    },
    [stateSessionId],
  );

  const handleRemoteDirChange = useCallback((dir: string | null) => {
    setPendingRemoteDir(dir);
  }, []);

  const handlePersonaChange = useCallback(
    (personaId: string | null) => {
      if (personaId === selectedPersonaId) {
        return;
      }

      const persona = personas.find((candidate) => candidate.id === personaId);
      const personaTarget = persona ? resolvePersonaTarget(persona) : undefined;

      if (personaTarget) {
        const harnessId = personaTarget.harnessId;
        if (!personaTarget.modelId) {
          if (!sessionId) {
            setPendingExecutionTarget(personaTarget);
            setPendingModelSelection(undefined);
            setGlobalSelectedProvider(harnessId);
          } else if (session?.creationState === "pending") {
            clearCurrentModelSelectionIntent(sessionId);
            replaceSessionTargetAfterDispatch(sessionId, personaTarget);
            setGlobalSelectedProvider(harnessId);
          } else {
            const previousTarget = session?.executionTarget;
            const requestId = createModelSelectionRequestId();
            clearCurrentModelSelectionIntent(sessionId);
            beginModelSelectionIntent(sessionId, {
              requestId,
              target: personaTarget,
              previousTarget,
            });
            setGlobalSelectedProvider(harnessId);
            void prepareCurrentSessionTarget(personaTarget)
              .then(() => {
                clearCurrentModelSelectionIntent(sessionId, requestId);
              })
              .catch((error) => {
                if (!isCurrentModelSelectionIntent(sessionId, requestId)) {
                  return;
                }
                clearCurrentModelSelectionIntent(sessionId, requestId);
                console.error("Failed to apply persona target:", error);
              });
          }
        } else {
          const personaModelProviderId = personaTarget.modelProviderId;
          const personaModelSelection: PreferredModelSelection = {
            id: personaTarget.modelId,
            name: personaTarget.modelName,
            modelProviderId: personaModelProviderId,
            source: "explicit",
          };

          if (!sessionId) {
            setPendingExecutionTarget(personaTarget);
            setPendingModelSelection(personaModelSelection);
            setGlobalSelectedProvider(harnessId);
          } else {
            const previousTarget = session?.executionTarget;
            const requestId = createModelSelectionRequestId();

            clearCurrentModelSelectionIntent(sessionId);
            beginModelSelectionIntent(sessionId, {
              requestId,
              target: personaTarget,
              previousTarget,
            });
            setGlobalSelectedProvider(harnessId);

            void applySessionModelSelection(
              personaModelProviderId,
              personaModelSelection,
              requestId,
            )
              .then(() => {
                clearCurrentModelSelectionIntent(sessionId, requestId);
              })
              .catch(async (error) => {
                const selectionStillCurrent = () =>
                  getModelSelectionIntent(sessionId)?.requestId === requestId;
                if (!selectionStillCurrent()) return;
                if (
                  await recoverStrandedProviderSession({
                    error,
                    sessionId,
                    providerId: personaModelProviderId,
                    modelSelection: personaModelSelection,
                    recreateSessionForProvider,
                    isSelectionCurrent: selectionStillCurrent,
                  })
                ) {
                  clearCurrentModelSelectionIntent(sessionId, requestId);
                  return;
                }
                if (!selectionStillCurrent()) return;
                clearCurrentModelSelectionIntent(sessionId, requestId);
                console.error("Failed to apply persona model:", error);
                rollbackToPreviousModel({
                  sessionId,
                  failedModelName: personaModelSelection.name,
                  previousTarget,
                  applySessionModelSelection,
                  prepareSelectedProvider,
                  setGlobalSelectedProvider,
                  restoreErrorMessage:
                    "Failed to restore previous model after persona model failure:",
                });
              });
          }
        }
      }
      const agentStore = useAgentStore.getState();
      const matchingAgent = agentStore.agents.find(
        (agent) => agent.personaId === personaId,
      );
      if (matchingAgent) {
        agentStore.setActiveAgent(matchingAgent.id);
      }
      if (!sessionId) {
        setPendingPersonaId(personaId);
        return;
      }
      useChatSessionStore
        .getState()
        .patchSession(sessionId, { personaId: personaId ?? undefined });
    },
    [
      applySessionModelSelection,
      personas,
      prepareCurrentSessionTarget,
      prepareSelectedProvider,
      recreateSessionForProvider,
      resolvePersonaTarget,
      session?.creationState,
      session?.executionTarget,
      sessionId,
      selectedPersonaId,
      setGlobalSelectedProvider,
    ],
  );

  const personaInfo = selectedPersona
    ? { id: selectedPersona.id, name: selectedPersona.displayName }
    : undefined;
  const pendingDraftStoreWriteRef = useRef<{
    sessionId: string;
    text: string;
    generation: number;
  } | null>(null);
  const draftStoreWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const draftGenerationRef = useRef(0);
  const submittedDraftsBySessionRef = useRef<
    Record<string, Array<{ text: string; generation: number }>>
  >({});
  const draftPreservingSubmissionsBySessionRef = useRef<
    Record<string, string[]>
  >({});
  const cancelPendingDraftStoreWrite = useCallback(
    (targetSessionId: string, targetGeneration?: number) => {
      const pending = pendingDraftStoreWriteRef.current;
      if (!pending || pending.sessionId !== targetSessionId) {
        return;
      }
      if (
        targetGeneration !== undefined &&
        pending.generation !== targetGeneration
      ) {
        return;
      }
      if (draftStoreWriteTimerRef.current !== null) {
        clearTimeout(draftStoreWriteTimerRef.current);
        draftStoreWriteTimerRef.current = null;
      }
      pendingDraftStoreWriteRef.current = null;
    },
    [],
  );
  const flushPendingDraftStoreWrite = useCallback(() => {
    if (draftStoreWriteTimerRef.current !== null) {
      clearTimeout(draftStoreWriteTimerRef.current);
      draftStoreWriteTimerRef.current = null;
    }
    const pending = pendingDraftStoreWriteRef.current;
    if (!pending) {
      return;
    }
    pendingDraftStoreWriteRef.current = null;
    useChatStore.getState().setDraft(pending.sessionId, pending.text);
  }, []);
  const recordDraftPreservingSubmission = useCallback(
    (targetSessionId: string, text: string) => {
      const preservedSubmissions =
        draftPreservingSubmissionsBySessionRef.current[targetSessionId] ?? [];
      preservedSubmissions.push(text);
      draftPreservingSubmissionsBySessionRef.current[targetSessionId] =
        preservedSubmissions.slice(-10);
    },
    [],
  );
  const recordSubmittedDraft = useCallback(
    (targetSessionId: string, text: string) => {
      const pending = pendingDraftStoreWriteRef.current;
      const storedDraft =
        useChatStore.getState().draftsBySession[targetSessionId] ?? "";
      const generation =
        pending?.sessionId === targetSessionId && pending.text === text
          ? pending.generation
          : storedDraft === text
            ? draftGenerationRef.current
            : null;
      if (generation === null) {
        recordDraftPreservingSubmission(targetSessionId, text);
        return;
      }

      const submittedDrafts =
        submittedDraftsBySessionRef.current[targetSessionId] ?? [];
      submittedDrafts.push({ text, generation });
      submittedDraftsBySessionRef.current[targetSessionId] =
        submittedDrafts.slice(-10);
    },
    [recordDraftPreservingSubmission],
  );
  const takeSubmittedDraftGeneration = useCallback(
    (targetSessionId: string, text: string) => {
      const submittedDrafts =
        submittedDraftsBySessionRef.current[targetSessionId];
      if (!submittedDrafts?.length) {
        return null;
      }

      const submittedIndex = submittedDrafts.findIndex(
        (submitted) => submitted.text === text,
      );
      if (submittedIndex === -1) {
        return null;
      }

      const [{ generation }] = submittedDrafts.splice(submittedIndex, 1);
      if (submittedDrafts.length === 0) {
        delete submittedDraftsBySessionRef.current[targetSessionId];
      }
      return generation;
    },
    [],
  );
  const takeDraftPreservingSubmission = useCallback(
    (targetSessionId: string, text: string) => {
      const preservedSubmissions =
        draftPreservingSubmissionsBySessionRef.current[targetSessionId];
      if (!preservedSubmissions?.length) {
        return false;
      }

      const submittedIndex = preservedSubmissions.indexOf(text);
      if (submittedIndex === -1) {
        return false;
      }

      preservedSubmissions.splice(submittedIndex, 1);
      if (preservedSubmissions.length === 0) {
        delete draftPreservingSubmissionsBySessionRef.current[targetSessionId];
      }
      return true;
    },
    [],
  );
  const moveDraftPreservingSubmissions = useCallback(
    (fromSessionId: string, toSessionId: string) => {
      const preservedSubmissions =
        draftPreservingSubmissionsBySessionRef.current[fromSessionId];
      if (!preservedSubmissions?.length) {
        return;
      }

      const targetSubmissions =
        draftPreservingSubmissionsBySessionRef.current[toSessionId] ?? [];
      draftPreservingSubmissionsBySessionRef.current[toSessionId] = [
        ...targetSubmissions,
        ...preservedSubmissions,
      ].slice(-10);
      delete draftPreservingSubmissionsBySessionRef.current[fromSessionId];
    },
    [],
  );
  const getDraftSnapshot = useCallback((targetSessionId: string) => {
    const pending = pendingDraftStoreWriteRef.current;
    if (pending?.sessionId === targetSessionId) {
      return pending;
    }

    const text = useChatStore.getState().draftsBySession[targetSessionId] ?? "";
    return { sessionId: targetSessionId, text, generation: null };
  }, []);
  const handleMessageAccepted = useCallback(
    (acceptedSessionId: string, submittedText: string) => {
      const submittedDraftGeneration = takeSubmittedDraftGeneration(
        acceptedSessionId,
        submittedText,
      );
      if (submittedDraftGeneration !== null) {
        cancelPendingDraftStoreWrite(
          acceptedSessionId,
          submittedDraftGeneration,
        );
      }
      const wasSubmittedWithoutDraftOwnership =
        submittedDraftGeneration === null &&
        takeDraftPreservingSubmission(acceptedSessionId, submittedText);
      const draftSnapshot = getDraftSnapshot(acceptedSessionId);
      const hasNewerDraftEdit =
        submittedDraftGeneration !== null &&
        draftGenerationRef.current > submittedDraftGeneration;
      if (
        submittedDraftGeneration === null &&
        !wasSubmittedWithoutDraftOwnership &&
        draftSnapshot.generation !== null &&
        draftSnapshot.text === submittedText
      ) {
        cancelPendingDraftStoreWrite(
          acceptedSessionId,
          draftSnapshot.generation,
        );
      }
      onMessageAccepted?.(acceptedSessionId);
      const pendingValue =
        pendingDefaultReasoningEffortBySessionRef.current[acceptedSessionId];
      const shouldPreserveDraft =
        hasNewerDraftEdit || wasSubmittedWithoutDraftOwnership;
      if (!pendingValue) {
        return shouldPreserveDraft ? false : undefined;
      }

      const queuedSave = reasoningEffortDefaultSaveQueueRef.current
        .catch(() => undefined)
        .then(() => saveDefaultReasoningEffort(pendingValue));
      reasoningEffortDefaultSaveQueueRef.current = queuedSave.catch(
        () => undefined,
      );

      void queuedSave
        .then(() => {
          if (
            pendingDefaultReasoningEffortBySessionRef.current[
              acceptedSessionId
            ] === pendingValue
          ) {
            delete pendingDefaultReasoningEffortBySessionRef.current[
              acceptedSessionId
            ];
          }
        })
        .catch((error) => {
          console.error("Failed to save default reasoning effort:", error);
        });
      return shouldPreserveDraft ? false : undefined;
    },
    [
      cancelPendingDraftStoreWrite,
      getDraftSnapshot,
      onMessageAccepted,
      takeDraftPreservingSubmission,
      takeSubmittedDraftGeneration,
    ],
  );
  const {
    messages,
    chatState,
    tokenState,
    sendMessage,
    steerMessage,
    compactConversation,
    stopStreaming,
    streamingMessageId,
    activeRunId,
    isRunCancellationPending,
  } = useChat(
    stateSessionId,
    selectedProvider,
    effectiveSystemPrompt,
    personaInfo,
    {
      onMessageAccepted: sessionId ? handleMessageAccepted : undefined,
      ensurePrepared: prepareSessionForCurrentSelection,
    },
  );
  const resolvedTokenState = tokenState ?? INITIAL_TOKEN_STATE;
  const supportsAutoCompactContext =
    supportsContextAutoCompaction(selectedAgentId);
  const supportsCompactionControls =
    supportsContextCompactionControls(selectedAgentId);
  const isCompactingContext = chatState === "compacting";
  const isQueuedSendBlocked = activeRunId !== null || isRunCancellationPending;
  const resolveAutoCompactAgentId = useCallback(
    (
      overridePersona?: { id: string | null; name?: string },
      sessionSelection?: SessionExecutionTarget,
    ): string | null => {
      if (sessionSelection) return sessionSelection.harnessId;
      if (overridePersona?.id === null) {
        return session?.executionTarget?.harnessId ?? selectedAgentId;
      }
      if (!overridePersona?.id) {
        return selectedAgentId;
      }

      const targetPersona = personas.find(
        (persona) => persona.id === overridePersona.id,
      );
      return (
        (targetPersona
          ? resolvePersonaTarget(targetPersona)?.harnessId
          : undefined) ?? selectedAgentId
      );
    },
    [
      personas,
      resolvePersonaTarget,
      selectedAgentId,
      session?.executionTarget?.harnessId,
    ],
  );
  const canAutoCompactBeforeSend = useCallback(
    (
      overridePersona?: { id: string | null; name?: string },
      sessionSelection?: SessionExecutionTarget,
    ) => {
      const targetAgentId = resolveAutoCompactAgentId(
        overridePersona,
        sessionSelection,
      );
      if (
        !sessionId ||
        !supportsContextAutoCompaction(targetAgentId) ||
        !isAutoCompactThresholdHydrated
      ) {
        return false;
      }

      const liveRuntime = useChatStore
        .getState()
        .getSessionRuntime(stateSessionId);
      return shouldAutoCompactContext(
        liveRuntime.tokenState.accumulatedTotal,
        liveRuntime.tokenState.contextLimit,
        autoCompactThreshold,
      );
    },
    [
      autoCompactThreshold,
      isAutoCompactThresholdHydrated,
      resolveAutoCompactAgentId,
      sessionId,
      stateSessionId,
    ],
  );
  const isQueuedSendBlockedNow = useCallback(() => {
    const liveRuntime = useChatStore
      .getState()
      .getSessionRuntime(stateSessionId);
    return (
      liveRuntime.activeRunId !== null || liveRuntime.isRunCancellationPending
    );
  }, [stateSessionId]);
  // Entry point this chat surface maps to for `berd_chat` session telemetry. An
  // agent-builder session takes precedence over the composer it was launched
  // from; otherwise Home's global composer vs the main chat view.
  const chatSourceSurface = useMemo<BerdChatChatSourceSurface>(() => {
    if (session?.intent === "build-agent") {
      return CHAT_SOURCE_SURFACE.AGENT_BUILDER;
    }
    return isHomeSession
      ? CHAT_SOURCE_SURFACE.GLOBAL_COMPOSER
      : CHAT_SOURCE_SURFACE.MAIN_CHAT;
  }, [isHomeSession, session?.intent]);
  // Fires `berd_chat` send telemetry for a foreground send dispatched by this
  // controller. A foreground send released from the deferred-workspace flow is
  // dispatched by the background queued-send pipeline instead and fires there
  // (`sendQueuedPromptToExistingSessionInBackground`), keyed off the surface
  // captured in its payload; berdctl/background sends carry no surface and
  // bypass telemetry entirely. It runs from the send's user-message-commit
  // callback — synchronously after sendCore appends the user message to the
  // transcript, or, for the steer paths below, once steerCore's backend
  // acknowledgement makes the steered user message durable — so a send that
  // fails before committing emits nothing and the queue's automatic retry of
  // it cannot double-fire; each accepted send emits exactly once.
  // Message.Sent fires every send; Session.Started fires once, on the
  // session's first user message — both are intended to co-fire on that first
  // send per the schema.
  const fireChatSendTelemetry = useCallback(
    (
      overridePersona?: { id: string | null; name?: string },
      attachments?: ChatAttachmentDraft[],
    ) => {
      if (!sessionId) {
        return;
      }
      // Observation only, structurally: this runs inside the send and steer
      // commit callbacks, where a throw would reject a dispatch the backend
      // already accepted — for steerQueuedMessage that skips queue.dismiss()
      // and the retained record re-sends as a duplicate user turn
      // (LAWS/CHAT.md: at most one user turn per message).
      try {
        // Post-commit read: the user message this send committed is already in
        // the transcript, so "first" means it is the only user message there —
        // and only once the session's history has landed, since an unreplayed
        // old session shows the same empty transcript (see chatFirstMessage).
        const isFirstMessage = isFirstCommittedUserMessage(sessionId);
        // An override with `id: null` is an explicit "send without a persona";
        // no override falls back to the session's selected persona.
        const hasPersona = overridePersona
          ? overridePersona.id !== null
          : Boolean(selectedPersonaId);
        const provider = selectedProvider;
        const model =
          session?.executionTarget?.modelId ?? effectiveModelSelection?.id;
        if (isFirstMessage) {
          trackChatSessionStarted({
            sessionId,
            sourceSurface: chatSourceSurface,
            hasProject: Boolean(effectiveProjectId),
            hasPersona,
            provider,
            model,
          });
        }
        trackChatMessageSent({
          sessionId,
          isFirstMessage,
          hasAttachments: (attachments?.length ?? 0) > 0,
          hasPersona,
          provider,
          model,
        });
      } catch (error) {
        perfLog(`[telemetry] chat send telemetry failed: ${String(error)}`);
      }
    },
    [
      chatSourceSurface,
      effectiveModelSelection?.id,
      effectiveProjectId,
      selectedPersonaId,
      selectedProvider,
      session?.executionTarget?.modelId,
      sessionId,
    ],
  );
  const sendWithAutoCompact = useCallback(
    (
      text: string,
      overridePersona?: { id: string | null; name?: string },
      attachments?: ChatAttachmentDraft[],
      sendOptions?: ChatSendOptions,
      sessionOverride?: Pick<
        ChatSession,
        "intent" | "agentBuilderOpen" | "targetAgentPath"
      >,
      options: { recordDraftSubmission?: boolean } = {},
    ) => {
      const builderSendOptions = composeBuilderSendOptions(
        sessionOverride ?? session,
        sendOptions,
      );
      const nextSendOptions = {
        ...(artifactFolderInstructions
          ? {
              ...builderSendOptions,
              assistantPrompt: composeSystemPrompt(
                artifactFolderInstructions,
                builderSendOptions.assistantPrompt,
              ),
            }
          : builderSendOptions),
        ...(sendOptions?.sessionSelection
          ? {
              sessionSelection: sendOptions.sessionSelection,
              sessionSelectionToken: sendOptions.sessionSelectionToken,
            }
          : {}),
      };
      const shouldPassSendOptions =
        Boolean(sendOptions) || nextSendOptions.assistantPrompt != null;

      if (isQueuedSendBlockedNow()) {
        return false;
      }

      const recordDraftSubmission = () => {
        if (options.recordDraftSubmission !== false && sessionId) {
          recordSubmittedDraft(sessionId, text);
        }
      };
      const dispatchSend = () => {
        const baseSendOptions = shouldPassSendOptions
          ? nextSendOptions
          : undefined;
        // Send telemetry is anchored to the user-message commit: firing it
        // here, before dispatch, would emit for preparation/dispatch failures
        // that commit nothing, and the queue's automatic retry of those would
        // double-fire Message.Sent and Session.Started.
        return sendMessage(text, overridePersona, attachments, {
          ...baseSendOptions,
          onUserMessageCommitted: () => {
            baseSendOptions?.onUserMessageCommitted?.();
            fireChatSendTelemetry(overridePersona, attachments);
          },
        });
      };

      if (
        !canAutoCompactBeforeSend(
          overridePersona,
          sendOptions?.sessionSelection,
        )
      ) {
        recordDraftSubmission();
        return dispatchSend();
      }

      return (async () => {
        const compactionResult = await compactConversation(
          overridePersona,
          sendOptions?.sessionSelection
            ? {
                sessionSelection: sendOptions.sessionSelection,
                sessionSelectionToken: sendOptions.sessionSelectionToken,
              }
            : undefined,
        );
        if (
          compactionResult !== "completed" &&
          compactionResult !== "completed-with-refresh-warning"
        ) {
          return false;
        }

        recordDraftSubmission();
        return dispatchSend();
      })();
    },
    [
      artifactFolderInstructions,
      canAutoCompactBeforeSend,
      compactConversation,
      fireChatSendTelemetry,
      isQueuedSendBlockedNow,
      recordSubmittedDraft,
      sendMessage,
      session,
      sessionId,
    ],
  );
  const isLoadingHistory = useChatStore((s) =>
    sessionId
      ? s.loadingSessionIds.has(sessionId) &&
        (s.messagesBySession[sessionId]?.length ?? 0) === 0
      : false,
  );
  const queuedHead = useChatStore(
    (state) => state.queuedMessageBySession[stateSessionId]?.[0] ?? null,
  );
  const hasQueuedMessages = queuedHead !== null;
  const deferredWorkspaceRecord = useChatStore((state) => {
    const record = state.queuedMessageBySession[stateSessionId]?.[0];
    return record?.kind === "deferred" &&
      (record.state as DeferredWorkspaceSend).type === "workspace-first-send"
      ? (record as typeof record & { state: DeferredWorkspaceSend })
      : null;
  });
  const unresolvedDeferredSend =
    deferredWorkspaceRecord?.state.error === UNRESOLVED_DEFERRED_SEND_ERROR &&
    !session?.executionTarget;
  const currentPreSendWorkspaceSetup =
    preSendWorkspaceSetup?.sessionId === stateSessionId
      ? preSendWorkspaceSetup
      : null;
  const canOfferPreSendWorkspaceSetup = Boolean(
    !readOnly &&
      sessionId &&
      session &&
      !sessionHasStarted &&
      !deferredWorkspaceRecord &&
      !hasQueuedMessages &&
      workspaceRepository.mode === "multi" &&
      project?.projectWorkspaces.some((workspace) =>
        isAskWorktreeStartupMode(workspace.startupMode),
      ) &&
      !workspaceAttachmentsEqualConfiguration(
        project.projectWorkspaces,
        session.workspaceAttachments,
      ),
  );
  const defaultWorkspaceSetup =
    (canOfferPreSendWorkspaceSetup || currentPreSendWorkspaceSetup) &&
    currentPreSendWorkspaceSetup?.status !== "selected"
      ? {
          status: currentPreSendWorkspaceSetup?.status ?? ("choice" as const),
          desired: project?.projectWorkspaces ?? [],
          error: currentPreSendWorkspaceSetup?.error,
        }
      : null;
  const preselectedWorkspaceStartupName =
    currentPreSendWorkspaceSetup?.status === "selected"
      ? currentPreSendWorkspaceSetup.startupName
      : undefined;
  useEffect(() => {
    if (
      !deferredWorkspaceRecord ||
      deferredWorkspaceRecord.state.error !== UNRESOLVED_DEFERRED_SEND_ERROR ||
      !session?.executionTarget
    ) {
      return;
    }
    void createDeferredWorkspaces(
      stateSessionId,
      deferredWorkspaceRecord.recordId,
      null,
    );
  }, [deferredWorkspaceRecord, session?.executionTarget, stateSessionId]);
  const queuedAgentBuilderSendNeedsPreparation = Boolean(
    session?.creationState == null &&
      queuedHead?.kind === "transport-ready" &&
      isAgentBuilderSkillSendOptions(queuedHead.payload.sendOptions) &&
      !session?.targetAgentPath,
  );
  const isQueuePreparationReady = Boolean(
    sessionId &&
      session?.creationState == null &&
      workspaceContextReady &&
      !deferredWorkspaceRecord &&
      !queuedAgentBuilderSendNeedsPreparation &&
      // Agent Builder owns a draft file that is keyed to the final backend
      // session id. Keep its accepted first send parked until that target is
      // ready, then let the normal queue drain compose the path-bound prompt.
      !(
        session?.intent === "build-agent" &&
        session.agentBuilderOpen !== false &&
        !session.targetAgentPath
      ),
  );
  const queueChatState = isQueuePreparationReady ? chatState : "thinking";
  const sendQueuedMessageWithAutoCompact = useCallback(
    (
      text: string,
      overridePersona?: { id: string | null; name?: string },
      attachments?: ChatAttachmentDraft[],
      sendOptions?: ChatSendOptions,
    ) => {
      const queuedPersona =
        overridePersona?.id === null
          ? undefined
          : overridePersona?.id
            ? useAgentStore.getState().getPersonaById(overridePersona.id)
            : selectedPersona;
      const derivedExecutionSystemPrompt = composeSystemPrompt(
        sendOptions?.capturedPersonaSystemPrompt ??
          formatPersonaSystemPrompt(queuedPersona),
        includedWorkspacesPrompt,
        workspaceInstructionsPrompt,
        appSkillsCatalogPrompt,
        availableSkillsCatalogPrompt,
      );
      const executionOptions = sendOptions?.executionSystemPrompt
        ? sendOptions
        : derivedExecutionSystemPrompt !== undefined
          ? {
              ...sendOptions,
              executionSystemPrompt: derivedExecutionSystemPrompt,
            }
          : sendOptions;
      return sendWithAutoCompact(
        text,
        overridePersona,
        attachments,
        executionOptions,
        undefined,
        { recordDraftSubmission: false },
      );
    },
    [
      appSkillsCatalogPrompt,
      availableSkillsCatalogPrompt,
      includedWorkspacesPrompt,
      selectedPersona,
      sendWithAutoCompact,
      workspaceInstructionsPrompt,
    ],
  );
  const queue = useMessageQueue(
    stateSessionId,
    queueChatState,
    sendQueuedMessageWithAutoCompact,
    readOnly,
    isQueuedSendBlocked,
    isQueuePreparationReady,
  );
  const pendingBuilderActivationRef = useRef<
    Record<
      string,
      {
        promise: Promise<ChatSession | null>;
        queueRecordId?: string;
      }
    >
  >({});

  const isQueuedAgentBuilderRecordAuthoritative = useCallback(
    (recordId: string) => {
      const record =
        useChatStore.getState().queuedMessageBySession[stateSessionId]?.[0];
      return Boolean(
        record?.recordId === recordId &&
          record.kind === "transport-ready" &&
          isAgentBuilderSkillSendOptions(record.payload.sendOptions),
      );
    },
    [stateSessionId],
  );

  const ensureCurrentSessionIsAgentBuilder = useCallback(
    async (options?: {
      requireSelectedSkill?: boolean;
      queueRecordId?: string;
    }) => {
      if (!sessionId) {
        return null;
      }

      const pendingActivation = pendingBuilderActivationRef.current[sessionId];
      if (pendingActivation) {
        if (
          !options?.queueRecordId ||
          pendingActivation.queueRecordId === options.queueRecordId
        ) {
          return pendingActivation.promise;
        }
        await pendingActivation.promise;
      }

      if (
        options?.queueRecordId &&
        !isQueuedAgentBuilderRecordAuthoritative(options.queueRecordId)
      ) {
        return null;
      }

      const activation = (async () => {
        const chatSessions = useChatSessionStore.getState();
        const currentSession = chatSessions.getSession(sessionId);
        if (!currentSession) {
          return null;
        }
        if (
          currentSession.intent === "build-agent" &&
          currentSession.targetAgentPath
        ) {
          if (currentSession.agentBuilderOpen !== true) {
            chatSessions.patchSession(sessionId, { agentBuilderOpen: true });
            return { ...currentSession, agentBuilderOpen: true };
          }
          return currentSession;
        }

        const target = await preSeedDraftAgent(sessionId);
        if (
          options?.queueRecordId &&
          !isQueuedAgentBuilderRecordAuthoritative(options.queueRecordId)
        ) {
          await deletePersonaSource(target.path).catch((error) => {
            console.error("Failed to delete superseded agent draft:", error);
          });
          return null;
        }

        const liveChatSessions = useChatSessionStore.getState();
        const liveSession = liveChatSessions.getSession(sessionId);
        const liveSkills =
          useChatStore.getState().skillDraftsBySession[stateSessionId] ??
          EMPTY_SKILL_DRAFTS;

        if (
          !liveSession ||
          liveSession.archivedAt ||
          (options?.requireSelectedSkill &&
            !hasAgentBuilderSkillDraft(liveSkills))
        ) {
          await deletePersonaSource(target.path).catch((error) => {
            console.error("Failed to delete canceled agent draft:", error);
          });
          return null;
        }

        if (
          liveSession.intent === "build-agent" &&
          liveSession.targetAgentPath
        ) {
          await deletePersonaSource(target.path).catch((error) => {
            console.error("Failed to delete duplicate agent draft:", error);
          });
          return liveSession;
        }

        const patch = {
          intent: "build-agent" as const,
          agentBuilderOpen: true,
          targetAgentPath: target.path,
          targetAgentSlug: target.slug,
        };

        liveChatSessions.patchSession(sessionId, patch);

        const chatStateNow = useChatStore.getState();
        const currentSkills =
          chatStateNow.skillDraftsBySession[stateSessionId] ??
          EMPTY_SKILL_DRAFTS;
        chatStateNow.setSkillDrafts(
          stateSessionId,
          ensureAgentBuilderSkillDraft(currentSkills),
        );

        return { ...currentSession, ...patch };
      })();

      const pendingEntry = {
        promise: activation,
        queueRecordId: options?.queueRecordId,
      };
      pendingBuilderActivationRef.current[sessionId] = pendingEntry;
      try {
        return await activation;
      } finally {
        if (pendingBuilderActivationRef.current[sessionId] === pendingEntry) {
          delete pendingBuilderActivationRef.current[sessionId];
        }
      }
    },
    [isQueuedAgentBuilderRecordAuthoritative, sessionId, stateSessionId],
  );

  useEffect(() => {
    if (!queuedAgentBuilderSendNeedsPreparation || !sessionId) {
      return;
    }
    const queueRecordId = queuedHead?.recordId;
    if (!queueRecordId) {
      return;
    }
    void ensureCurrentSessionIsAgentBuilder({ queueRecordId }).catch(
      (error) => {
        if (!isQueuedAgentBuilderRecordAuthoritative(queueRecordId)) {
          return;
        }
        console.error("Failed to prepare queued agent builder:", error);
        markAgentBuilderSessionPreparationFailed(sessionId);
      },
    );
  }, [
    ensureCurrentSessionIsAgentBuilder,
    isQueuedAgentBuilderRecordAuthoritative,
    queuedAgentBuilderSendNeedsPreparation,
    queuedHead?.recordId,
    sessionId,
  ]);

  const captureSessionSelection = useCallback(
    (payload: QueuedMessagePayload): QueuedMessagePayload => {
      const requestedPersona =
        payload.persona.kind === "persona"
          ? useAgentStore.getState().getPersonaById(payload.persona.id)
          : undefined;
      const queuedPersona =
        payload.persona.kind === "inherit" ? selectedPersona : requestedPersona;
      const capturedPersonaSystemPrompt =
        formatPersonaSystemPrompt(queuedPersona);
      const executionSystemPrompt = workspaceContextReady
        ? composeSystemPrompt(
            capturedPersonaSystemPrompt,
            includedWorkspacesPrompt,
            workspaceInstructionsPrompt,
            appSkillsCatalogPrompt,
            availableSkillsCatalogPrompt,
          )
        : undefined;
      const sendOptions = {
        ...payload.sendOptions,
        ...(capturedPersonaSystemPrompt !== undefined
          ? { capturedPersonaSystemPrompt }
          : {}),
        ...(executionSystemPrompt !== undefined
          ? { executionSystemPrompt }
          : {}),
        // A captured payload can be dispatched outside this controller — a
        // deferred-workspace first send is released to the background
        // queued-send pipeline — so its send telemetry keeps the surface that
        // accepted it instead of losing it to that pipeline.
        telemetrySourceSurface: chatSourceSurface,
      };
      return {
        ...payload,
        persona:
          payload.persona.kind === "persona"
            ? {
                ...payload.persona,
                name: queuedPersona?.displayName ?? payload.persona.name,
              }
            : payload.persona,
        sendOptions,
      };
    },
    [
      appSkillsCatalogPrompt,
      availableSkillsCatalogPrompt,
      chatSourceSurface,
      includedWorkspacesPrompt,
      selectedPersona,
      workspaceContextReady,
      workspaceInstructionsPrompt,
    ],
  );

  const updateCapturedQueuedMessage = useCallback(
    (recordId: string, payload: QueuedMessagePayload) => {
      const updated = queue.update(recordId, captureSessionSelection(payload));
      if (updated && sessionId) {
        recordDraftPreservingSubmission(sessionId, payload.text);
      }
      return updated;
    },
    [
      captureSessionSelection,
      queue,
      recordDraftPreservingSubmission,
      sessionId,
    ],
  );

  const enqueueCapturedMessage = useCallback(
    (payload: QueuedMessagePayload) =>
      queue.enqueue(
        payload.text,
        payload.persona.kind === "persona"
          ? payload.persona.id
          : payload.persona.kind === "none"
            ? null
            : undefined,
        payload.attachments,
        payload.sendOptions,
        payload.persona.kind === "persona" ? payload.persona.name : undefined,
      ),
    [queue],
  );

  const handleSend = useCallback(
    (
      text: string,
      personaId?: string | null,
      attachments?: ChatAttachmentDraft[],
      sendOptions?: ChatSendOptions,
    ) => {
      if (currentPreSendWorkspaceSetup?.status === "creating") {
        return false;
      }
      const personaName = personaId
        ? selectedPersona?.id === personaId
          ? selectedPersona.displayName
          : useAgentStore.getState().getPersonaById(personaId)?.displayName
        : undefined;
      const enqueueMessage = (options = sendOptions) => {
        const accepted = enqueueCapturedMessage(
          captureSessionSelection({
            text,
            persona: personaIntentFromComposer(personaId, personaName),
            attachments,
            sendOptions: options,
          }),
        );
        if (accepted && sessionId) {
          recordDraftPreservingSubmission(sessionId, text);
        }
        return accepted;
      };
      // A remote host picked in this composer routes the send into a fresh
      // session on that host's backend. The current session is never mutated:
      // a session's backend is fixed at creation, so "switch to remote" means
      // "start the chat over there".
      if (remoteHostSelectionEnabled && pendingRemoteHost && !readOnly) {
        const remoteHost = pendingRemoteHost;
        const remoteDir = pendingRemoteDir ?? null;
        if (!remoteDir) {
          // The composer already blocks send with an inline reason when the
          // remote directory is missing; this is a backstop.
          return false;
        }
        // Creating the remote session takes a moment (ssh connect + ACP
        // session/new); a re-submit in that window must not create a second
        // session.
        if (remoteSendInFlightRef.current) {
          return false;
        }
        remoteSendInFlightRef.current = true;
        const payload = captureSessionSelection({
          text,
          persona: personaIntentFromComposer(personaId, personaName),
          attachments: remoteSafeAttachments(attachments),
          sendOptions,
        });
        const remoteExecutionTarget =
          pendingExecutionTarget !== undefined
            ? (pendingExecutionTarget ?? undefined)
            : session?.executionTarget;
        return (async () => {
          try {
            await ensureRemoteHostConnected(remoteHost);
            const created = await useChatSessionStore.getState().createSession({
              executionTarget: remoteExecutionTarget,
              personaId:
                payload.persona.kind === "persona"
                  ? payload.persona.id
                  : (selectedPersonaId ?? undefined),
              // The project association is local metadata (grouping, sidebar);
              // the workspace itself lives on the remote host.
              projectId: effectiveProjectId ?? undefined,
              workingDir: remoteDir,
              remoteHost,
            });
            const firstSend = acceptFirstSend(created.id, payload, {
              queueReady: true,
            });
            if (!firstSend.accepted) {
              return false;
            }
            setPendingRemoteHost(undefined);
            setPendingRemoteDir(undefined);
            activateSession(created.id);
            onMessageAccepted?.(created.id);
            return true;
          } catch (error) {
            console.error("Failed to start remote session:", error);
            toast.error(i18n.t("chat:toolbar.remoteHost.startFailed"), {
              description: formatAcpErrorMessage(error),
            });
            return false;
          } finally {
            remoteSendInFlightRef.current = false;
          }
        })();
      }
      if (!sessionId) {
        if (readOnly) {
          return false;
        }
        return enqueueMessage();
      }

      if (readOnly) {
        return false;
      }

      // Draft sessions are interactive before backend creation finishes. Admit
      // an ordinary first send through the same first-send path used by ready
      // sessions, then let the queue's readiness gate hold it until promotion
      // replaces the renderer-local id with the backend session id.
      if (session?.creationState === "pending") {
        const payload = captureSessionSelection({
          text,
          persona: personaIntentFromComposer(personaId, personaName),
          attachments,
          sendOptions,
        });
        const hasQueuedMessages =
          (useChatStore.getState().queuedMessageBySession[stateSessionId]
            ?.length ?? 0) > 0;
        const accepted = hasQueuedMessages
          ? enqueueCapturedMessage(payload)
          : acceptFirstSend(sessionId, payload, {
              queueReady: true,
              startupName: preselectedWorkspaceStartupName,
              onNeedsName: onWorkspaceNameRequest,
            }).accepted;
        if (!accepted) {
          return false;
        }
        recordDraftPreservingSubmission(sessionId, text);
        onMessageAccepted?.(sessionId);
        if (personaId && personaId !== selectedPersonaId) {
          handlePersonaChange(personaId);
        }
        return true;
      }

      if (
        (session?.intent !== "build-agent" ||
          session.agentBuilderOpen === false) &&
        isAgentBuilderSkillSendOptions(sendOptions)
      ) {
        return (async () => {
          const builderSession = await ensureCurrentSessionIsAgentBuilder();
          if (!builderSession) return false;
          const onBuilderWorkspaceNameRequest = onWorkspaceNameRequest
            ? (request: WorkspaceNameRequest) =>
                onWorkspaceNameRequest({
                  ...request,
                  cancel: () => {
                    request.cancel();
                    const liveSession = useChatSessionStore
                      .getState()
                      .getSession(sessionId);
                    if (
                      liveSession?.intent === "build-agent" &&
                      liveSession.targetAgentPath ===
                        builderSession.targetAgentPath
                    ) {
                      useChatSessionStore.getState().patchSession(sessionId, {
                        intent: undefined,
                        targetAgentPath: undefined,
                        targetAgentSlug: undefined,
                      });
                      if (builderSession.targetAgentPath) {
                        void deletePersonaSource(
                          builderSession.targetAgentPath,
                        ).catch((error) => {
                          console.error(
                            "Failed to delete canceled agent draft:",
                            error,
                          );
                        });
                      }
                    }
                  },
                })
            : undefined;
          const deferredSendOptions = composeBuilderSendOptions(
            builderSession,
            sendOptions,
          );
          if (
            (useChatStore.getState().queuedMessageBySession[stateSessionId]
              ?.length ?? 0) > 0
          ) {
            enqueueMessage(deferredSendOptions);
            return true;
          }
          const firstSend = acceptFirstSend(
            sessionId,
            captureSessionSelection({
              text,
              persona: personaIntentFromComposer(personaId, personaName),
              attachments,
              sendOptions: deferredSendOptions,
            }),
            {
              cancelBuilderDraftPath:
                builderSession.targetAgentPath ?? undefined,
              startupName: preselectedWorkspaceStartupName,
              onNeedsName: onBuilderWorkspaceNameRequest,
            },
          );
          if (firstSend.accepted) {
            recordDraftPreservingSubmission(sessionId, text);
            onMessageAccepted?.(sessionId);
            if (personaId && personaId !== selectedPersonaId) {
              handlePersonaChange(personaId);
            }
            return true;
          }
          if (firstSend.needsName || firstSend.occupied) return false;
          if (personaId && personaId !== selectedPersonaId) {
            const accepted = enqueueMessage(deferredSendOptions);
            if (accepted) {
              handlePersonaChange(personaId);
            }
            return accepted;
          }
          if (!workspaceContextReady) {
            enqueueMessage(deferredSendOptions);
            return true;
          }
          return enqueueMessage(deferredSendOptions);
        })();
      }

      if ((queue.queuedRecords?.length ?? 0) > 0) {
        enqueueMessage();
        return true;
      }

      if (personaId && personaId !== selectedPersonaId) {
        const firstSend = acceptFirstSend(
          sessionId,
          captureSessionSelection({
            text,
            persona: personaIntentFromComposer(personaId, personaName),
            attachments,
            sendOptions,
          }),
          {
            startupName: preselectedWorkspaceStartupName,
            onNeedsName: onWorkspaceNameRequest,
          },
        );
        if (firstSend.accepted) {
          recordDraftPreservingSubmission(sessionId, text);
          onMessageAccepted?.(sessionId);
          handlePersonaChange(personaId);
          return true;
        }
        if (firstSend.needsName || firstSend.occupied) return false;

        const accepted = enqueueMessage();
        if (accepted) {
          handlePersonaChange(personaId);
        }
        return accepted;
      }

      const currentSession = useChatSessionStore
        .getState()
        .getSession(sessionId);
      const preparedSendOptions =
        currentSession?.intent === "build-agent"
          ? composeBuilderSendOptions(currentSession, sendOptions)
          : sendOptions;
      const firstSend = acceptFirstSend(
        sessionId,
        captureSessionSelection({
          text,
          persona: personaIntentFromComposer(personaId, personaName),
          attachments,
          sendOptions: preparedSendOptions,
        }),
        {
          startupName: preselectedWorkspaceStartupName,
          onNeedsName: onWorkspaceNameRequest,
        },
      );
      if (firstSend.accepted) {
        recordDraftPreservingSubmission(sessionId, text);
        onMessageAccepted?.(sessionId);
        return true;
      }
      if (firstSend.needsName || firstSend.occupied) return false;

      if (!workspaceContextReady) {
        enqueueMessage(preparedSendOptions);
        return true;
      }

      return enqueueMessage(preparedSendOptions);
    },
    [
      captureSessionSelection,
      currentPreSendWorkspaceSetup?.status,
      enqueueCapturedMessage,
      ensureCurrentSessionIsAgentBuilder,
      handlePersonaChange,
      onMessageAccepted,
      onWorkspaceNameRequest,
      pendingExecutionTarget,
      pendingRemoteDir,
      pendingRemoteHost,
      preselectedWorkspaceStartupName,
      queue,
      readOnly,
      recordDraftPreservingSubmission,
      remoteHostSelectionEnabled,
      session?.agentBuilderOpen,
      session?.creationState,
      session?.executionTarget,
      session?.intent,
      sessionId,
      selectedPersona,
      selectedPersonaId,
      stateSessionId,
      workspaceContextReady,
      effectiveProjectId,
    ],
  );

  const steerQueuedMessage = useCallback(async () => {
    const queuedMessage = queue.queuedMessage;
    if (!supportsSteering || !queuedMessage || !sessionId || readOnly) {
      return false;
    }

    const accepted = await steerMessage(
      queuedMessage.text,
      queuedMessage.attachments,
      {
        ...queuedMessage.sendOptions,
        // Same telemetry anchor as dispatchSend: steerCore fires this only
        // once the backend acknowledges the steer (the provisional append is
        // rolled back otherwise), so a rejected steer emits nothing and the
        // retained record can still emit when it later drains or re-steers.
        onUserMessageCommitted: () => {
          queuedMessage.sendOptions?.onUserMessageCommitted?.();
          fireChatSendTelemetry(undefined, queuedMessage.attachments);
        },
      },
    );
    if (accepted) {
      queue.dismiss();
    }
    return accepted;
  }, [
    fireChatSendTelemetry,
    queue,
    readOnly,
    sessionId,
    steerMessage,
    supportsSteering,
  ]);

  const steerDraftMessage = useCallback(
    async (
      text: string,
      _personaId?: string,
      attachments?: ChatAttachmentDraft[],
      sendOptions?: ChatSendOptions,
    ) => {
      if (
        !sessionId ||
        readOnly ||
        !supportsSteering ||
        (chatState !== "thinking" && chatState !== "streaming")
      ) {
        return false;
      }

      return steerMessage(text, attachments, {
        ...sendOptions,
        // Same telemetry anchor as dispatchSend; see steerQueuedMessage.
        onUserMessageCommitted: () => {
          sendOptions?.onUserMessageCommitted?.();
          fireChatSendTelemetry(undefined, attachments);
        },
      });
    },
    [
      chatState,
      fireChatSendTelemetry,
      readOnly,
      sessionId,
      steerMessage,
      supportsSteering,
    ],
  );

  const handleCreatePersona = useCallback(() => {
    if (onCreatePersonaRequested) {
      onCreatePersonaRequested();
      return;
    }
    console.warn("Create-persona requested without an AppShell handler");
  }, [onCreatePersonaRequested]);

  const sessionDraftValue = useChatStore((s) =>
    sessionId ? (s.draftsBySession[sessionId] ?? "") : "",
  );
  const sessionSkillDrafts = useChatStore((s) =>
    sessionId
      ? (s.skillDraftsBySession[sessionId] ?? EMPTY_SKILL_DRAFTS)
      : EMPTY_SKILL_DRAFTS,
  );
  const sessionDraftAttachments = useChatStore((s) =>
    sessionId
      ? (s.draftAttachmentsBySession[sessionId] ?? EMPTY_ATTACHMENT_DRAFTS)
      : EMPTY_ATTACHMENT_DRAFTS,
  );
  const draftAttachments = sessionId
    ? sessionDraftAttachments
    : pendingDraftAttachments;
  const draftValue = sessionId ? sessionDraftValue : pendingDraftValue;
  const storedSelectedSkills = sessionId
    ? sessionSkillDrafts
    : pendingSkillDrafts;
  const selectedSkills = storedSelectedSkills;
  const hasSelectedAgentBuilderSkill =
    hasAgentBuilderSkillDraft(selectedSkills);
  const agentBuilderSkillSelectionRef = useRef({
    sessionId: null as string | null,
    selected: false,
  });
  const handleDraftChange = useCallback(
    (text: string) => {
      if (pendingDraftStoreWriteRef.current?.sessionId !== stateSessionId) {
        flushPendingDraftStoreWrite();
      }
      const generation = draftGenerationRef.current + 1;
      draftGenerationRef.current = generation;
      pendingDraftStoreWriteRef.current = {
        sessionId: stateSessionId,
        text,
        generation,
      };
      if (text.length === 0) {
        flushPendingDraftStoreWrite();
        return;
      }
      if (draftStoreWriteTimerRef.current !== null) {
        clearTimeout(draftStoreWriteTimerRef.current);
      }
      draftStoreWriteTimerRef.current = setTimeout(
        flushPendingDraftStoreWrite,
        DRAFT_STORE_UPDATE_DEBOUNCE_MS,
      );
    },
    [flushPendingDraftStoreWrite, stateSessionId],
  );
  useEffect(() => flushPendingDraftStoreWrite, [flushPendingDraftStoreWrite]);
  useEffect(() => {
    const clientSessionId = session?.clientSessionId;
    if (!sessionId || !clientSessionId || clientSessionId === sessionId) {
      return;
    }
    moveDraftPreservingSubmissions(clientSessionId, sessionId);
    const pending = pendingDraftStoreWriteRef.current;
    if (pending?.sessionId !== clientSessionId) {
      return;
    }
    pendingDraftStoreWriteRef.current = {
      sessionId,
      text: pending.text,
      generation: pending.generation,
    };
    flushPendingDraftStoreWrite();
  }, [
    flushPendingDraftStoreWrite,
    moveDraftPreservingSubmissions,
    session?.clientSessionId,
    sessionId,
  ]);
  const handleSkillsChange = useCallback(
    (skills: typeof selectedSkills) => {
      useChatStore.getState().setSkillDrafts(stateSessionId, skills);
    },
    [stateSessionId],
  );
  const handleDraftAttachmentsChange = useCallback(
    (attachments: ChatAttachmentDraft[]) => {
      useChatStore.getState().setDraftAttachments(stateSessionId, attachments);
    },
    [stateSessionId],
  );

  useEffect(() => {
    const previousSelection = agentBuilderSkillSelectionRef.current;
    const selectionBelongsToCurrentSession =
      previousSelection.sessionId === stateSessionId;
    const skillWasJustSelected =
      hasSelectedAgentBuilderSkill &&
      (selectionBelongsToCurrentSession
        ? !previousSelection.selected
        : session?.intent !== "build-agent");

    agentBuilderSkillSelectionRef.current = {
      sessionId: stateSessionId,
      selected: hasSelectedAgentBuilderSkill,
    };

    if (
      !sessionId ||
      !skillWasJustSelected ||
      session?.creationState === "pending" ||
      (session?.intent === "build-agent" && session.agentBuilderOpen !== false)
    ) {
      return;
    }

    void ensureCurrentSessionIsAgentBuilder({
      requireSelectedSkill: true,
    })
      .then((builderSession) => {
        if (!builderSession) {
          return;
        }

        const chatState = useChatStore.getState();
        if (
          isAgentBuilderMentionOnlyDraft(
            chatState.draftsBySession[stateSessionId] ?? "",
          )
        ) {
          chatState.clearDraft(stateSessionId);
        }
      })
      .catch((error) => {
        console.error("Failed to prepare selected agent builder:", error);
        markAgentBuilderSessionPreparationFailed(sessionId);
      });
  }, [
    ensureCurrentSessionIsAgentBuilder,
    hasSelectedAgentBuilderSkill,
    session?.agentBuilderOpen,
    session?.creationState,
    session?.intent,
    sessionId,
    stateSessionId,
  ]);

  const scrollTarget = useChatStore((s) =>
    sessionId ? (s.scrollTargetMessageBySession[sessionId] ?? null) : null,
  );
  const handleScrollTargetHandled = useCallback(() => {
    if (!sessionId) {
      return;
    }
    useChatStore.getState().clearScrollTargetMessage(sessionId);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !isHomeSession) {
      return;
    }

    flushPendingDraftStoreWrite();

    // Pending values are read off the store below; the closures above keep
    // them in the dep array so this effect re-runs when home-side pending
    // state mutates.
    void pendingDraftValue;
    void pendingSkillDrafts;
    void pendingDraftAttachments;
    void pendingQueuedMessage;

    const chatStateNow = useChatStore.getState();
    const pendingDraft =
      chatStateNow.draftsBySession[PENDING_HOME_SESSION_ID] ?? "";
    const pendingSkills =
      chatStateNow.skillDraftsBySession[PENDING_HOME_SESSION_ID] ?? [];
    const pendingAttachments =
      chatStateNow.draftAttachmentsBySession[PENDING_HOME_SESSION_ID] ?? [];

    if (pendingDraft && !chatStateNow.draftsBySession[sessionId]) {
      chatStateNow.setDraft(sessionId, pendingDraft);
    }
    if (
      pendingSkills.length > 0 &&
      !chatStateNow.skillDraftsBySession[sessionId]?.length
    ) {
      chatStateNow.setSkillDrafts(sessionId, pendingSkills);
    }
    if (
      pendingAttachments.length > 0 &&
      !chatStateNow.draftAttachmentsBySession[sessionId]?.length
    ) {
      chatStateNow.setDraftAttachments(sessionId, pendingAttachments);
    }

    const hasPendingExecutionTarget = pendingExecutionTarget !== undefined;
    const hasPendingPersona = pendingPersonaId !== undefined;
    const hasPendingProject = pendingProjectId !== undefined;
    const hasPendingModel = pendingModelSelection !== undefined;

    if (
      hasPendingExecutionTarget ||
      hasPendingPersona ||
      hasPendingProject ||
      hasPendingModel
    ) {
      const nextHarnessId =
        pendingExecutionTarget?.harnessId ?? selectedProvider;
      const nextPersonaId =
        pendingPersonaId !== undefined
          ? (pendingPersonaId ?? undefined)
          : session?.personaId;
      const nextProjectId =
        pendingProjectId !== undefined ? pendingProjectId : session?.projectId;
      const nextProject =
        nextProjectId == null
          ? null
          : (useProjectStore
              .getState()
              .projects.find((candidate) => candidate.id === nextProjectId) ??
            null);
      const sessionStore = useChatSessionStore.getState();
      const previousSession = sessionStore.getSession(sessionId);
      const previousTarget = previousSession?.executionTarget;
      const requestedHomeModel = pendingModelSelection ?? null;
      const requestedModelProviderId =
        pendingExecutionTarget?.modelProviderId ??
        requestedHomeModel?.modelProviderId ??
        (nextHarnessId === "goose" ? undefined : nextHarnessId);
      const nextTarget =
        !hasPendingExecutionTarget && !hasPendingModel
          ? previousTarget
          : pendingExecutionTarget === null
            ? undefined
            : (pendingExecutionTarget ??
              (requestedHomeModel?.id && requestedModelProviderId
                ? targetFromAgentModelSelection(nextHarnessId, {
                    modelProviderId: requestedModelProviderId,
                    modelId: requestedHomeModel.id,
                    modelName: requestedHomeModel.name,
                  })
                : normalizeSessionExecutionTarget({
                    harnessId: nextHarnessId,
                  })));

      const patch: Partial<Pick<ChatSession, "personaId" | "projectId">> = {};

      if (hasPendingPersona) {
        patch.personaId = nextPersonaId;
      }
      if (hasPendingProject) {
        patch.projectId = nextProjectId ?? null;
        void updateSessionProject(sessionId, nextProjectId ?? null).catch(
          console.error,
        );
      }

      sessionStore.patchSession(sessionId, patch);
      // Consume pending state synchronously so a model-refresh-driven
      // re-render of this effect cannot replay it.
      setPendingExecutionTarget(undefined);
      setPendingPersonaId(undefined);
      setPendingProjectId(undefined);
      setPendingModelSelection(undefined);

      if (hasPendingExecutionTarget || hasPendingModel) {
        if (!nextTarget) {
          clearCurrentModelSelectionIntent(sessionId);
          replaceSessionTargetAfterDispatch(sessionId, undefined);
        } else {
          const homePendingModel = isModelExecutionTarget(nextTarget)
            ? {
                id: nextTarget.modelId,
                name: nextTarget.modelName,
                modelProviderId: nextTarget.modelProviderId,
                source: requestedHomeModel?.source ?? ("default" as const),
              }
            : null;
          const homePendingModelProviderId =
            homePendingModel?.modelProviderId ?? nextTarget.harnessId;
          const selectionRequestId = createModelSelectionRequestId();
          const nextWireProviderId =
            gooseServeSelectionFromExecutionTarget(nextTarget).providerId ??
            nextHarnessId;

          beginModelSelectionIntent(sessionId, {
            requestId: selectionRequestId,
            target: nextTarget,
            previousTarget,
          });
          void syncPendingHomeModelSelection({
            sessionId,
            nextWireProviderId,
            nextProject,
            workspacePath: activeWorkspace?.path,
            homePendingModel,
            homePendingModelProviderId,
            selectionRequestId,
            previousTarget,
            catalogEntries,
            prepareCurrentSession,
            applySessionModelSelection,
            setGlobalSelectedProvider,
            recreateSessionForProvider,
          });
        }
      }
    }

    if (pendingQueuedMessage) {
      const movedRecordIds = movePendingHomeQueuedMessages(sessionId);
      if (movedRecordIds.length === 0) return;
      const firstMovedRecordId = movedRecordIds[0];
      const chatStore = useChatStore.getState();
      chatStore.markQueuedMessagesReady(sessionId);
      const movedRecord = chatStore.queuedMessageBySession[sessionId]?.find(
        (record) => record.recordId === firstMovedRecordId,
      );
      if (
        !movedRecord ||
        !prepareExistingFirstSend(sessionId, movedRecord.recordId, {
          onNeedsName: (request) => {
            onMessageAccepted?.(sessionId);
            onWorkspaceNameRequest?.(request);
          },
          onChoice: () => onMessageAccepted?.(sessionId),
        })
      ) {
        const chatStore = useChatStore.getState();
        for (const recordId of movedRecordIds) {
          chatStore.moveQueuedMessage(
            sessionId,
            PENDING_HOME_SESSION_ID,
            recordId,
          );
        }
        return;
      }
    }
    useChatStore.getState().clearDraft(PENDING_HOME_SESSION_ID);
    useChatStore.getState().clearSkillDrafts(PENDING_HOME_SESSION_ID);
    useChatStore.getState().clearDraftAttachments(PENDING_HOME_SESSION_ID);
    useChatStore.getState().dismissQueuedMessage(PENDING_HOME_SESSION_ID);
    useChatStore.getState().cleanupSession(PENDING_HOME_SESSION_ID);
  }, [
    activeWorkspace?.path,
    applySessionModelSelection,
    catalogEntries,
    isHomeSession,
    pendingDraftValue,
    pendingSkillDrafts,
    pendingDraftAttachments,
    pendingModelSelection,
    pendingExecutionTarget,
    pendingPersonaId,
    pendingProjectId,
    onWorkspaceNameRequest,
    onMessageAccepted,
    pendingQueuedMessage,
    prepareCurrentSession,
    recreateSessionForProvider,
    selectedProvider,
    setGlobalSelectedProvider,
    flushPendingDraftStoreWrite,
    session?.personaId,
    session?.projectId,
    sessionId,
  ]);

  const dismissQueuedMessage = useCallback(
    (recordId?: string) => {
      if (readOnly) return;
      const liveQueuedRecords =
        sessionId != null
          ? (useChatStore.getState().queuedMessageBySession[sessionId] ?? [])
          : [];
      const queuedRecords = queue.queuedRecords ?? liveQueuedRecords;
      const targetRecord = recordId
        ? queuedRecords.find((record) => record.recordId === recordId)
        : (queue.queuedRecord ?? queuedRecords[0]);
      const cancelBuilderDraftPath =
        targetRecord?.kind === "deferred"
          ? (targetRecord.state as DeferredWorkspaceSend).cancelBuilderDraftPath
          : undefined;
      queue.dismiss(recordId);
      if (!cancelBuilderDraftPath || !sessionId) return;

      const liveSession = useChatSessionStore.getState().getSession(sessionId);
      if (
        liveSession?.intent !== "build-agent" ||
        liveSession.targetAgentPath !== cancelBuilderDraftPath
      ) {
        return;
      }
      useChatSessionStore.getState().patchSession(sessionId, {
        intent: undefined,
        targetAgentPath: undefined,
        targetAgentSlug: undefined,
      });
      void deletePersonaSource(cancelBuilderDraftPath).catch((error) => {
        console.error("Failed to delete canceled agent draft:", error);
      });
    },
    [queue, readOnly, sessionId],
  );

  return {
    session,
    project,
    sessionArtifactCwd,
    messages,
    chatState,
    tokenState: resolvedTokenState,
    stopStreaming,
    streamingMessageId,
    compactConversation,
    canCompactContext:
      supportsCompactionControls &&
      messages.length > 0 &&
      chatState === "idle" &&
      !isQueuedSendBlocked,
    isCompactingContext,
    supportsAutoCompactContext,
    supportsCompactionControls,
    isContextUsageReady:
      hasContextUsageSnapshot && resolvedTokenState.contextLimit > 0,
    isLoadingHistory,
    queue: {
      ...queue,
      update: updateCapturedQueuedMessage,
      dismiss: dismissQueuedMessage,
    },
    deferredWorkspaceRecord,
    defaultWorkspaceSetup,
    deferredWorkspaceError: deferredWorkspaceRecord?.state.error,
    unresolvedDeferredSend,
    cancelDeferredWorkspaceName: () => {
      if (defaultWorkspaceSetup?.status === "naming") {
        setPreSendWorkspaceSetup({
          sessionId: stateSessionId,
          status: "choice",
        });
        return true;
      }
      return readOnly ? false : cancelDeferredWorkspaceNaming(stateSessionId);
    },
    createDeferredWorkspace: () => {
      if (defaultWorkspaceSetup?.status === "choice") {
        setPreSendWorkspaceSetup({
          sessionId: stateSessionId,
          status: "naming",
        });
        return true;
      }
      return readOnly
        ? false
        : chooseDeferredWorkspaceSetup(stateSessionId, true);
    },
    submitDeferredWorkspaceName: (name: string) => {
      if (defaultWorkspaceSetup?.status === "naming" && project) {
        const operationId = preSendWorkspaceOperationRef.current + 1;
        preSendWorkspaceOperationRef.current = operationId;
        setPreSendWorkspaceSetup({
          sessionId: stateSessionId,
          status: "creating",
        });
        void provisionPreSendProjectWorkspaces(
          stateSessionId,
          project,
          name,
        ).then(
          () =>
            setPreSendWorkspaceSetup((current) =>
              preSendWorkspaceOperationRef.current === operationId &&
              current?.sessionId === stateSessionId
                ? null
                : current,
            ),
          (error) => {
            console.error("Failed to configure project worktree:", error);
            setPreSendWorkspaceSetup((current) =>
              preSendWorkspaceOperationRef.current === operationId &&
              current?.sessionId === stateSessionId
                ? {
                    sessionId: stateSessionId,
                    status: "naming",
                    error:
                      error instanceof Error ? error.message : String(error),
                  }
                : current,
            );
          },
        );
        return;
      }
      return !readOnly && deferredWorkspaceRecord?.state.status === "naming"
        ? void createDeferredWorkspaces(
            stateSessionId,
            deferredWorkspaceRecord.recordId,
            name,
          )
        : undefined;
    },
    skipDeferredWorkspace: () => {
      if (defaultWorkspaceSetup) {
        setPreSendWorkspaceSetup({
          sessionId: stateSessionId,
          status: "selected",
          startupName: null,
        });
        return true;
      }
      return readOnly
        ? false
        : chooseDeferredWorkspaceSetup(stateSessionId, false);
    },
    sendDeferredAnyway: () =>
      !readOnly &&
      deferredWorkspaceRecord &&
      session?.creationState !== "failed"
        ? releaseDeferredWorkspaceSend(
            stateSessionId,
            deferredWorkspaceRecord.recordId,
            true,
          )
        : false,
    handleSend,
    workspaceSetupInProgress:
      currentPreSendWorkspaceSetup?.status === "creating",
    steerDraftMessage,
    canSteerMessage: Boolean(
      sessionId &&
        !readOnly &&
        supportsSteering &&
        (chatState === "thinking" || chatState === "streaming"),
    ),
    canSteerQueuedMessage: Boolean(
      sessionId &&
        !readOnly &&
        supportsSteering &&
        (chatState === "thinking" || chatState === "streaming") &&
        queue.queuedMessage &&
        (queue.queuedMessage.text.trim() ||
          (queue.queuedMessage.attachments?.length ?? 0) > 0),
    ),
    steerQueuedMessage,
    draftValue,
    handleDraftChange,
    draftAttachments,
    handleDraftAttachmentsChange,
    selectedSkills,
    handleSkillsChange,
    skillProjectDirs,
    fileMentionProjectDirs,
    skillsEnabled: skillProviderCapabilities.supportsSkillMentions,
    scrollTarget,
    handleScrollTargetHandled,
    projectMetadataPending,
    workspaceContextReady,
    personas: displayedPersonas,
    selectedPersonaId,
    selectedPersona,
    handlePersonaChange,
    handleCreatePersona,
    pickerAgents,
    providersLoading,
    selectedProvider: selectedAgentId,
    handleProviderChange: handleProviderChangeWithContextReset,
    currentModelId: effectiveModelSelection?.id ?? null,
    currentModelProviderId: effectiveModelSelection?.modelProviderId ?? null,
    currentModelName: effectiveModelSelection?.name ?? null,
    currentExecutionTarget: session?.executionTarget,
    availableModels,
    modelsLoading,
    modelStatusMessage,
    handleModelChange: handleModelChangeWithContextReset,
    handlePickerOpen: handlePickerOpenWithReasoningRefresh,
    reasoningEffort: session?.reasoningEffort,
    handleReasoningEffortChange,
    selectedProjectId: effectiveProjectId,
    availableProjects,
    handleProjectChange,
    remoteHostSelectionEnabled,
    selectedRemoteHost,
    selectedRemoteDir,
    handleRemoteHostChange,
    handleRemoteDirChange,
  };
}
