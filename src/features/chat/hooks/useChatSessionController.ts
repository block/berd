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
import { useChatStore } from "../stores/chatStore";
import {
  hasSessionStarted,
  useChatSessionStore,
  type ChatSession,
} from "../stores/chatSessionStore";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { selectPersonas } from "@/features/agents/stores/agentSelectors";
import { useProviderSelection } from "@/features/agents/hooks/useProviderSelection";
import { useProjectStore } from "@/features/projects/stores/projectStore";
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
import { applyLatestSessionConfig } from "../lib/sessionConfigRequests";
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
  releaseDeferredWorkspaceSend,
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
import { preSeedDraftAgent } from "@/features/agents/lib/agentBuilderSession";
import { resolvePersonaProvider } from "@/features/agents/lib/resolvePersonaProvider";
import { deletePersonaSource } from "@/shared/api/agents";
import type { Persona } from "@/shared/types/agents";
import {
  ensureAgentBuilderSkillDraft,
  hasAgentBuilderSkillDraft,
  isAgentBuilderSkillSendOptions,
} from "../lib/agentBuilderSkill";
import {
  createModelSelectionRequestId,
  isCurrentModelSelectionIntent,
  rollbackToPreviousModel,
  type ApplySessionModelSelection,
  type ModelSelectionApplyOptions,
  type PreferredModelSelection,
  type PreviousModelSelection,
} from "../model-selection/modelSelectionIntent";
import {
  collectStrandedComposerText,
  recoverStrandedProviderSession,
  type RecreateSessionForProvider,
} from "../model-selection/strandedProviderRecovery";

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

function chooseFallbackModel(models: ModelOption[]): ModelOption | undefined {
  return (
    models.find((model) => model.recommended) ??
    models.find((model) => model.featured) ??
    models[0]
  );
}

interface PendingHomeModelSyncArgs {
  sessionId: string;
  nextProviderId: string;
  nextProject: SessionCwdProject;
  workspacePath?: string | null;
  homePendingModel: PreferredModelSelection | null;
  homePendingProviderId: string;
  modelIntentRequestId: string | null;
  previous: PreviousModelSelection;
  catalogEntries: ProviderCatalogEntries;
  prepareCurrentSession: (
    providerId: string,
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
  nextProviderId,
  nextProject,
  workspacePath,
  homePendingModel,
  homePendingProviderId,
  modelIntentRequestId,
  previous,
  catalogEntries,
  prepareCurrentSession,
  applySessionModelSelection,
  setGlobalSelectedProvider,
  recreateSessionForProvider,
}: PendingHomeModelSyncArgs): Promise<void> {
  try {
    if (!homePendingModel?.id || !modelIntentRequestId) {
      await prepareCurrentSession(nextProviderId, nextProject, workspacePath);
      return;
    }

    const applied = await applySessionModelSelection(
      homePendingProviderId,
      homePendingModel,
      modelIntentRequestId,
      {
        nextProject,
        nextWorkspacePath: workspacePath,
      },
    );
    const liveStore = useChatSessionStore.getState();
    const intentStillMatches =
      liveStore.getModelSelectionIntent(sessionId)?.requestId ===
      modelIntentRequestId;
    if (intentStillMatches) {
      liveStore.clearModelSelectionIntent(sessionId, modelIntentRequestId);
    }
    if (
      applied &&
      intentStillMatches &&
      homePendingModel.source === "explicit"
    ) {
      const agentId =
        resolveAgentProviderCatalogIdStrictFromEntries(
          catalogEntries,
          homePendingProviderId,
        ) ?? "goose";
      setStoredModelPreference(agentId, {
        modelId: homePendingModel.id,
        modelName: homePendingModel.name,
        providerId: homePendingProviderId,
      });
    }
  } catch (error) {
    if (!homePendingModel?.id || !modelIntentRequestId) {
      // Even a plain prepare (no explicit model) hits the read-current gate on
      // a dead provider; recreate onto the target rather than restoring the
      // corpse's identity onto the session.
      if (
        await recoverStrandedProviderSession({
          error,
          sessionId,
          providerId: nextProviderId,
          recreateSessionForProvider,
        })
      ) {
        return;
      }
      console.error("Failed to sync pending Home state:", error);
      useChatSessionStore.getState().patchSession(sessionId, {
        providerId: previous.providerId,
        modelId: previous.modelId,
        modelName: previous.modelName,
      });
      if (previous.providerId) {
        setGlobalSelectedProvider(previous.providerId);
      }
      return;
    }

    const liveStore = useChatSessionStore.getState();
    const intentStillMatches =
      liveStore.getModelSelectionIntent(sessionId)?.requestId ===
      modelIntentRequestId;
    if (!intentStillMatches) {
      return;
    }
    liveStore.clearModelSelectionIntent(sessionId, modelIntentRequestId);
    // The Home composer's pending model lands here after the real session is
    // born — the exact first-chat path on a machine where the default
    // provider cannot construct. Recreate onto the pending choice instead of
    // rolling back onto the dead provider.
    if (
      await recoverStrandedProviderSession({
        error,
        sessionId,
        providerId: homePendingProviderId,
        modelSelection: homePendingModel,
        recreateSessionForProvider,
        onRecovered: () => {
          if (homePendingModel.source !== "explicit") {
            return;
          }
          const agentId =
            resolveAgentProviderCatalogIdStrictFromEntries(
              catalogEntries,
              homePendingProviderId,
            ) ?? "goose";
          setStoredModelPreference(agentId, {
            modelId: homePendingModel.id,
            modelName: homePendingModel.name,
            providerId: homePendingProviderId,
          });
        },
      })
    ) {
      return;
    }
    console.error("Failed to sync pending Home state:", error);
    rollbackToPreviousModel({
      sessionId,
      failedModelName: homePendingModel.name,
      previous,
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
  const [pendingProviderId, setPendingProviderId] = useState<string>();
  const [pendingModelSelection, setPendingModelSelection] =
    useState<PreferredModelSelection | null>();
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
    sessionId ? (s.messagesBySession[sessionId]?.length ?? 0) : 0,
  );
  const sessionHasStarted = session
    ? hasSessionStarted(session, sessionLocalMessageCount)
    : false;
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
    pendingProviderId ?? session?.providerId ?? globalSelectedProvider;
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
      const workingDir = await resolveSessionCwd(
        nextProject,
        nextWorkspacePath,
      );
      if (requestId && !isCurrentModelSelectionIntent(sessionId, requestId)) {
        return false;
      }
      const result = await applyLatestSessionConfig({
        sessionId,
        providerId,
        workingDir,
      });
      if (!result.applied) {
        return result.applied;
      }
      if (requestId && !isCurrentModelSelectionIntent(sessionId, requestId)) {
        return false;
      }

      useChatSessionStore.getState().patchSession(sessionId, {
        workingDir,
        ...(result.configOptionsSnapshot?.reasoningEffort
          ? { reasoningEffort: result.configOptionsSnapshot.reasoningEffort }
          : {}),
      });
      return true;
    },
    [project, sessionId, sessionWorkspacePath],
  );
  const prepareCurrentSessionWithModel = useCallback(
    async (
      providerId: string,
      nextProject = project,
      nextWorkspacePath: string | null | undefined = sessionWorkspacePath,
    ) => {
      if (!sessionId) {
        return false;
      }
      const sessionStore = useChatSessionStore.getState();
      const liveSession = sessionStore.getSession(sessionId);
      const modelIntent = sessionStore.getModelSelectionIntent(sessionId);
      const modelToApply =
        modelIntent?.kind === "model" && modelIntent.modelId
          ? {
              id: modelIntent.modelId,
              name: modelIntent.modelName ?? modelIntent.modelId,
              providerId: modelIntent.providerId,
              requestId: modelIntent.requestId,
            }
          : liveSession?.modelId
            ? {
                id: liveSession.modelId,
                name: liveSession.modelName ?? liveSession.modelId,
                providerId: liveSession.providerId,
                requestId: undefined,
              }
            : null;

      if (!modelToApply) {
        return prepareCurrentSession(
          providerId,
          nextProject,
          nextWorkspacePath,
        );
      }

      if (modelToApply.providerId && modelToApply.providerId !== providerId) {
        return prepareCurrentSession(
          providerId,
          nextProject,
          nextWorkspacePath,
        );
      }

      const workingDir = await resolveSessionCwd(
        nextProject,
        nextWorkspacePath,
      );
      const modelStillCurrent = () => {
        const liveStore = useChatSessionStore.getState();
        const liveIntent = liveStore.getModelSelectionIntent(sessionId);
        if (modelToApply.requestId) {
          if (liveIntent) {
            return liveIntent.requestId === modelToApply.requestId;
          }
          const latestSession = liveStore.getSession(sessionId);
          return (
            latestSession?.providerId === providerId &&
            latestSession.modelId === modelToApply.id
          );
        }
        if (liveIntent) {
          return false;
        }
        const latestSession = liveStore.getSession(sessionId);
        return (
          latestSession?.providerId === providerId &&
          latestSession.modelId === modelToApply.id
        );
      };
      if (!modelStillCurrent()) {
        return false;
      }
      const result = await applyLatestSessionConfig({
        sessionId,
        providerId,
        workingDir,
        modelId: modelToApply.id,
      });
      if (!result.applied) {
        return result.applied;
      }
      if (!modelStillCurrent()) {
        return false;
      }

      useChatSessionStore.getState().patchSession(sessionId, {
        workingDir,
        modelId: modelToApply.id,
        modelName: modelToApply.name,
        ...(result.configOptionsSnapshot?.reasoningEffort
          ? { reasoningEffort: result.configOptionsSnapshot.reasoningEffort }
          : {}),
      });
      delete pendingDefaultReasoningEffortBySessionRef.current[sessionId];
      return true;
    },
    [prepareCurrentSession, project, sessionWorkspacePath, sessionId],
  );
  const prepareSelectedProvider = useCallback(
    (providerId: string, options?: ModelSelectionApplyOptions) =>
      prepareCurrentSession(
        providerId,
        options?.nextProject ?? project,
        options?.nextWorkspacePath ?? sessionWorkspacePath,
        options?.requestId,
      ),
    [prepareCurrentSession, project, sessionWorkspacePath],
  );

  const applySessionModelSelection = useCallback<ApplySessionModelSelection>(
    async (
      providerId: string,
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
      const workingDir = await resolveSessionCwd(
        options?.nextProject ?? project,
        options?.nextWorkspacePath ?? sessionWorkspacePath,
      );
      // resolveSessionCwd can yield while the user changes models; do not send
      // a stale provider/model pair to ACP after that happens.
      if (!isCurrentModelSelectionIntent(sessionId, requestId)) {
        return false;
      }
      const result = await applyLatestSessionConfig({
        sessionId,
        providerId,
        workingDir,
        modelId: modelSelection.id,
      });
      // applyLatestSessionConfig queues latest-only work. A newer request may
      // have superseded this one while ACP was being prepared, so only patch
      // local state if this request still owns the intent.
      if (!isCurrentModelSelectionIntent(sessionId, requestId)) {
        return false;
      }
      if (!result.applied) {
        return false;
      }
      let configOptionsSnapshot = result.configOptionsSnapshot;
      if (isHomeSession && !configOptionsSnapshot?.reasoningEffort) {
        const refreshResult = await applyLatestSessionConfig({
          sessionId,
          providerId,
          workingDir,
          modelId: modelSelection.id,
          forceConfigRefresh: true,
        });
        if (!isCurrentModelSelectionIntent(sessionId, requestId)) {
          return false;
        }
        if (refreshResult.applied) {
          configOptionsSnapshot = refreshResult.configOptionsSnapshot;
        }
      }
      useChatSessionStore.getState().patchSession(sessionId, {
        workingDir,
        modelId: modelSelection.id,
        modelName: modelSelection.name,
        ...(configOptionsSnapshot?.reasoningEffort
          ? { reasoningEffort: configOptionsSnapshot.reasoningEffort }
          : {}),
      });
      delete pendingDefaultReasoningEffortBySessionRef.current[sessionId];
      return true;
    },
    [isHomeSession, project, sessionId, sessionWorkspacePath],
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
      const workingDir = await resolveSessionCwd(
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
        providerId,
        workingDir,
        modelId,
        modelName: modelId ? (modelSelection?.name ?? undefined) : undefined,
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
    [activeWorkspace?.path, project, session?.workingDir, sessionId],
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
    setPendingProviderId,
    setPendingModelSelection,
    setGlobalSelectedProvider,
    prepareSelectedProvider,
    applySessionModelSelection,
    recreateSessionForProvider,
  });

  const refreshMissingReasoningEffort = useCallback(async () => {
    if (!sessionId || readOnly || session?.reasoningEffort) {
      return;
    }

    const modelId = session?.modelId ?? effectiveModelSelection?.id;
    const providerId =
      effectiveModelSelection?.providerId ?? session?.providerId;
    if (!modelId || !providerId) {
      return;
    }

    const refreshKey = [
      providerId,
      modelId,
      session?.workingDir ?? activeWorkspace?.path ?? "",
    ].join("\u0000");
    if (
      reasoningEffortRefreshKeyBySessionRef.current[sessionId] === refreshKey
    ) {
      return;
    }
    reasoningEffortRefreshKeyBySessionRef.current[sessionId] = refreshKey;

    try {
      const workingDir = await resolveSessionCwd(
        project,
        activeWorkspace?.path ?? session?.workingDir,
      );
      const result = await applyLatestSessionConfig({
        sessionId,
        providerId,
        workingDir,
        modelId,
        forceConfigRefresh: true,
      });
      if (!result.applied) {
        return;
      }
      const reasoningEffort = result.configOptionsSnapshot?.reasoningEffort;
      if (!reasoningEffort) {
        return;
      }
      const liveSession = useChatSessionStore.getState().getSession(sessionId);
      if (liveSession?.modelId && liveSession.modelId !== modelId) {
        return;
      }
      useChatSessionStore.getState().patchSession(sessionId, {
        workingDir,
        modelId: liveSession?.modelId ?? modelId,
        modelName:
          liveSession?.modelName ?? effectiveModelSelection?.name ?? modelId,
        reasoningEffort,
      });
    } catch (error) {
      console.error("Failed to refresh reasoning effort config:", error);
    }
  }, [
    activeWorkspace?.path,
    effectiveModelSelection?.id,
    effectiveModelSelection?.name,
    effectiveModelSelection?.providerId,
    project,
    readOnly,
    session?.modelId,
    session?.providerId,
    session?.reasoningEffort,
    session?.workingDir,
    sessionId,
  ]);

  const handlePickerOpenWithReasoningRefresh = useCallback(() => {
    handlePickerOpen();
    void refreshMissingReasoningEffort();
  }, [handlePickerOpen, refreshMissingReasoningEffort]);

  const resolvePersonaModelSelection = useCallback(
    (
      persona: Persona,
      providerId: string,
    ): PreferredModelSelection | undefined => {
      const providerModels = getModelsForAgent(providerId);
      const savedModel = persona.model
        ? providerModels.find((model) => model.id === persona.model)
        : undefined;
      const model = savedModel ?? chooseFallbackModel(providerModels);
      if (!model) {
        return undefined;
      }

      return {
        id: model.id,
        name: model.displayName ?? model.name,
        providerId,
        source: savedModel ? "explicit" : "default",
      };
    },
    [getModelsForAgent],
  );
  const prepareSessionForPersona = useCallback(
    async (personaId?: string) => {
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
      const persona = personaId
        ? useAgentStore.getState().getPersonaById(personaId)
        : undefined;
      if (!persona?.provider) {
        return selectedProvider
          ? prepareCurrentSessionWithModel(
              selectedProvider,
              project,
              preparationWorkspacePath,
            )
          : undefined;
      }

      const matchingProvider = resolvePersonaProvider(persona, providers);
      if (!matchingProvider) {
        return selectedProvider
          ? prepareCurrentSessionWithModel(
              selectedProvider,
              project,
              preparationWorkspacePath,
            )
          : undefined;
      }

      const personaModelSelection = resolvePersonaModelSelection(
        persona,
        matchingProvider.id,
      );
      if (!personaModelSelection) {
        return prepareCurrentSession(
          matchingProvider.id,
          project,
          preparationWorkspacePath,
        );
      }

      const workingDir = await resolveSessionCwd(
        project,
        preparationWorkspacePath,
      );
      const result = await applyLatestSessionConfig({
        sessionId: stateSessionId,
        providerId: matchingProvider.id,
        workingDir,
        modelId: personaModelSelection.id,
      });
      if (!result.applied) {
        return result.applied;
      }

      useChatSessionStore.getState().patchSession(stateSessionId, {
        workingDir,
        providerId: matchingProvider.id,
        modelId: personaModelSelection.id,
        modelName: personaModelSelection.name,
        ...(result.configOptionsSnapshot?.reasoningEffort
          ? { reasoningEffort: result.configOptionsSnapshot.reasoningEffort }
          : {}),
      });
      return true;
    },
    [
      prepareCurrentSession,
      prepareCurrentSessionWithModel,
      project,
      providers,
      resolvePersonaModelSelection,
      selectedProvider,
      stateSessionId,
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
    void prepareCurrentSessionWithModel(
      selectedProvider,
      project,
      activeWorkspace?.path,
    ).catch((error) => {
      console.error("Failed to prepare ACP session:", error);
    });
  }, [
    activeWorkspace,
    prepareCurrentSessionWithModel,
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
      const nextProviderId = model?.providerId;
      if (
        modelId === effectiveModelSelection?.id &&
        (!nextProviderId ||
          nextProviderId === effectiveModelSelection?.providerId)
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
      effectiveModelSelection?.providerId,
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

      void acpSetSessionConfigOption(sessionId, current.configId, value).catch(
        (error) => {
          console.error("Failed to set reasoning effort:", error);
          if (
            pendingDefaultReasoningEffortBySessionRef.current[sessionId] ===
            value
          ) {
            delete pendingDefaultReasoningEffortBySessionRef.current[sessionId];
          }
          useChatSessionStore.getState().patchSession(sessionId, {
            reasoningEffort: current,
          });
        },
      );
    },
    [session?.reasoningEffort, sessionHasStarted, sessionId],
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

  const handlePersonaChange = useCallback(
    (personaId: string | null) => {
      if (personaId === selectedPersonaId) {
        return;
      }

      const persona = personas.find((candidate) => candidate.id === personaId);

      if (persona?.provider) {
        const matchingProvider = resolvePersonaProvider(persona, providers);
        if (matchingProvider) {
          const personaModelSelection = resolvePersonaModelSelection(
            persona,
            matchingProvider.id,
          );

          if (!sessionId) {
            setPendingProviderId(matchingProvider.id);
            setPendingModelSelection(personaModelSelection);
            setGlobalSelectedProvider(matchingProvider.id);
          } else if (personaModelSelection) {
            const sessionStore = useChatSessionStore.getState();
            const previousProviderId = session?.providerId;
            const previousModelId = session?.modelId;
            const previousModelName = session?.modelName;
            const requestId = createModelSelectionRequestId();

            sessionStore.clearModelSelectionIntent(sessionId);
            sessionStore.beginModelSelectionIntent(sessionId, {
              requestId,
              kind: "model",
              providerId: matchingProvider.id,
              modelId: personaModelSelection.id,
              modelName: personaModelSelection.name,
              previousProviderId,
              previousModelId,
              previousModelName,
            });
            sessionStore.patchSession(sessionId, {
              providerId: matchingProvider.id,
              modelId: personaModelSelection.id,
              modelName: personaModelSelection.name,
            });
            setGlobalSelectedProvider(matchingProvider.id);

            void applySessionModelSelection(
              matchingProvider.id,
              personaModelSelection,
              requestId,
            )
              .then(() => {
                useChatSessionStore
                  .getState()
                  .clearModelSelectionIntent(sessionId, requestId);
              })
              .catch(async (error) => {
                const liveStore = useChatSessionStore.getState();
                const intentStillMatches =
                  liveStore.getModelSelectionIntent(sessionId)?.requestId ===
                  requestId;
                if (!intentStillMatches) {
                  return;
                }
                liveStore.clearModelSelectionIntent(sessionId, requestId);
                // The agent editor and persona switches route here — when the
                // session's live provider is unset (dead default on a machine
                // without its credentials), the in-place apply can never
                // succeed, so recreate onto the persona's provider instead of
                // rolling back onto the corpse.
                if (
                  await recoverStrandedProviderSession({
                    error,
                    sessionId,
                    providerId: matchingProvider.id,
                    modelSelection: personaModelSelection,
                    recreateSessionForProvider,
                  })
                ) {
                  return;
                }
                console.error("Failed to apply persona model:", error);
                rollbackToPreviousModel({
                  sessionId,
                  failedModelName: personaModelSelection.name,
                  previous: {
                    providerId: previousProviderId,
                    modelId: previousModelId,
                    modelName: previousModelName,
                  },
                  applySessionModelSelection,
                  prepareSelectedProvider,
                  setGlobalSelectedProvider,
                  restoreErrorMessage:
                    "Failed to restore previous model after persona model failure:",
                });
              });
          } else {
            handleProviderChange(matchingProvider.id);
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
      handleProviderChange,
      applySessionModelSelection,
      personas,
      prepareSelectedProvider,
      providers,
      recreateSessionForProvider,
      resolvePersonaModelSelection,
      session?.modelId,
      session?.modelName,
      session?.providerId,
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
      ensurePrepared: prepareSessionForPersona,
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
    (overridePersona?: { id: string; name?: string }): string | null => {
      if (!overridePersona?.id) {
        return selectedAgentId;
      }

      const targetPersona = personas.find(
        (persona) => persona.id === overridePersona.id,
      );
      if (!targetPersona?.provider) {
        return selectedAgentId;
      }

      const targetAgentId = resolveAgentProviderCatalogIdStrictFromEntries(
        catalogEntries,
        targetPersona.provider,
      );
      if (targetAgentId) {
        return targetAgentId;
      }

      const isGooseModelProvider = providers.some(
        (provider) =>
          provider.id === targetPersona.provider ||
          provider.label.toLowerCase().includes(targetPersona.provider ?? ""),
      );
      return isGooseModelProvider ? "goose" : null;
    },
    [catalogEntries, personas, providers, selectedAgentId],
  );
  const canAutoCompactBeforeSend = useCallback(
    (overridePersona?: { id: string; name?: string }) => {
      const targetAgentId = resolveAutoCompactAgentId(overridePersona);
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
  const sendWithAutoCompact = useCallback(
    (
      text: string,
      overridePersona?: { id: string; name?: string },
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
      const nextSendOptions = artifactFolderInstructions
        ? {
            ...builderSendOptions,
            assistantPrompt: composeSystemPrompt(
              artifactFolderInstructions,
              builderSendOptions.assistantPrompt,
            ),
          }
        : builderSendOptions;
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

      if (!canAutoCompactBeforeSend(overridePersona)) {
        recordDraftSubmission();
        if (shouldPassSendOptions) {
          void sendMessage(text, overridePersona, attachments, nextSendOptions);
        } else {
          void sendMessage(text, overridePersona, attachments);
        }
        return true;
      }

      return (async () => {
        const compactionResult = await compactConversation(overridePersona);
        if (compactionResult !== "completed") {
          return false;
        }

        recordDraftSubmission();
        if (shouldPassSendOptions) {
          void sendMessage(text, overridePersona, attachments, nextSendOptions);
        } else {
          void sendMessage(text, overridePersona, attachments);
        }
        return true;
      })();
    },
    [
      artifactFolderInstructions,
      canAutoCompactBeforeSend,
      compactConversation,
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
  const deferredSend = useRef<{
    text: string;
    attachments?: ChatAttachmentDraft[];
    sendOptions?: ChatSendOptions;
    resolve?: (accepted: boolean) => void;
  } | null>(null);
  const deferredWorkspaceRecord = useChatStore((state) => {
    const record = state.queuedMessageBySession[stateSessionId]?.[0];
    return record?.kind === "deferred" &&
      (record.state as DeferredWorkspaceSend).type === "workspace-first-send"
      ? (record as typeof record & { state: DeferredWorkspaceSend })
      : null;
  });
  const queueChatState =
    sessionId &&
    session?.creationState == null &&
    workspaceContextReady &&
    !deferredWorkspaceRecord
      ? chatState
      : "thinking";
  const sendQueuedMessageWithAutoCompact = useCallback(
    (
      text: string,
      overridePersona?: { id: string; name?: string },
      attachments?: ChatAttachmentDraft[],
      sendOptions?: ChatSendOptions,
    ) =>
      sendWithAutoCompact(
        text,
        overridePersona,
        attachments,
        sendOptions,
        undefined,
        { recordDraftSubmission: false },
      ),
    [sendWithAutoCompact],
  );
  const queue = useMessageQueue(
    stateSessionId,
    queueChatState,
    sendQueuedMessageWithAutoCompact,
    readOnly,
    isQueuedSendBlocked,
  );
  const pendingBuilderActivationRef = useRef<
    Record<string, Promise<ChatSession | null>>
  >({});

  const ensureCurrentSessionIsAgentBuilder = useCallback(
    async (options?: { requireSelectedSkill?: boolean }) => {
      if (!sessionId) {
        return null;
      }

      const pendingActivation = pendingBuilderActivationRef.current[sessionId];
      if (pendingActivation) {
        return pendingActivation;
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

      pendingBuilderActivationRef.current[sessionId] = activation;
      try {
        return await activation;
      } finally {
        if (pendingBuilderActivationRef.current[sessionId] === activation) {
          delete pendingBuilderActivationRef.current[sessionId];
        }
      }
    },
    [sessionId, stateSessionId],
  );

  const handleSend = useCallback(
    (
      text: string,
      personaId?: string,
      attachments?: ChatAttachmentDraft[],
      sendOptions?: ChatSendOptions,
    ) => {
      if (!sessionId) {
        if (readOnly) {
          return false;
        }
        return queue.enqueue(text, personaId, attachments, sendOptions);
      }

      if (readOnly) {
        return false;
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
            recordDraftPreservingSubmission(sessionId, text);
            useChatStore
              .getState()
              .enqueueTransportReadyMessage(stateSessionId, {
                text,
                personaId,
                attachments,
                sendOptions: deferredSendOptions,
              });
            return true;
          }
          const firstSend = acceptFirstSend(
            sessionId,
            { text, personaId, attachments, sendOptions: deferredSendOptions },
            {
              cancelBuilderDraftPath:
                builderSession.targetAgentPath ?? undefined,
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
            handlePersonaChange(personaId);
            return new Promise<boolean>((resolve) => {
              deferredSend.current = {
                text,
                attachments,
                sendOptions,
                resolve,
              };
            });
          }
          if (!workspaceContextReady) {
            queue.enqueue(text, personaId, attachments, deferredSendOptions);
            return true;
          }
          return sendWithAutoCompact(
            text,
            undefined,
            attachments,
            sendOptions,
            builderSession,
          );
        })();
      }

      if ((queue.queuedRecords?.length ?? 0) > 0) {
        recordDraftPreservingSubmission(sessionId, text);
        queue.enqueue(text, personaId, attachments, sendOptions);
        return true;
      }

      if (personaId && personaId !== selectedPersonaId) {
        const firstSend = acceptFirstSend(
          sessionId,
          { text, personaId, attachments, sendOptions },
          { onNeedsName: onWorkspaceNameRequest },
        );
        if (firstSend.accepted) {
          recordDraftPreservingSubmission(sessionId, text);
          onMessageAccepted?.(sessionId);
          handlePersonaChange(personaId);
          return true;
        }
        if (firstSend.needsName || firstSend.occupied) return false;

        handlePersonaChange(personaId);
        return new Promise<boolean>((resolve) => {
          deferredSend.current = { text, attachments, sendOptions, resolve };
        });
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
        { text, personaId, attachments, sendOptions: preparedSendOptions },
        { onNeedsName: onWorkspaceNameRequest },
      );
      if (firstSend.accepted) {
        recordDraftPreservingSubmission(sessionId, text);
        onMessageAccepted?.(sessionId);
        return true;
      }
      if (firstSend.needsName || firstSend.occupied) return false;

      if (!workspaceContextReady) {
        queue.enqueue(text, personaId, attachments, preparedSendOptions);
        return true;
      }

      if (chatState !== "idle" || isQueuedSendBlocked) {
        recordDraftPreservingSubmission(sessionId, text);
        queue.enqueue(text, personaId, attachments, preparedSendOptions);
        return true;
      }

      return sendWithAutoCompact(
        text,
        personaId
          ? selectedPersona?.id === personaId
            ? { id: selectedPersona.id, name: selectedPersona.displayName }
            : { id: personaId }
          : undefined,
        attachments,
        preparedSendOptions,
      );
    },
    [
      chatState,
      ensureCurrentSessionIsAgentBuilder,
      handlePersonaChange,
      isQueuedSendBlocked,
      onMessageAccepted,
      onWorkspaceNameRequest,
      queue,
      readOnly,
      recordDraftPreservingSubmission,
      session?.agentBuilderOpen,
      session?.intent,
      sessionId,
      selectedPersona,
      selectedPersonaId,
      sendWithAutoCompact,
      stateSessionId,
      workspaceContextReady,
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
      queuedMessage.sendOptions,
    );
    if (accepted) {
      queue.dismiss();
    }
    return accepted;
  }, [queue, readOnly, sessionId, steerMessage, supportsSteering]);

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

      return steerMessage(text, attachments, sendOptions);
    },
    [chatState, readOnly, sessionId, steerMessage, supportsSteering],
  );

  useEffect(() => {
    if (deferredSend.current && selectedPersona) {
      if (!workspaceContextReady) {
        return;
      }
      const { text, attachments, sendOptions, resolve } = deferredSend.current;
      deferredSend.current = null;
      if (readOnly) {
        useChatStore.getState().setDraft(stateSessionId, text);
        resolve?.(false);
        return;
      }

      void (async () => {
        const needsBuilderActivation =
          (session?.intent !== "build-agent" ||
            session.agentBuilderOpen === false) &&
          isAgentBuilderSkillSendOptions(sendOptions);
        const builderSession = needsBuilderActivation
          ? await ensureCurrentSessionIsAgentBuilder()
          : undefined;
        if (needsBuilderActivation && !builderSession) {
          useChatStore.getState().setDraft(stateSessionId, text);
          resolve?.(false);
          return;
        }

        const sendResult = sendWithAutoCompact(
          text,
          undefined,
          attachments,
          sendOptions,
          builderSession ?? undefined,
        );
        const accepted =
          sendResult instanceof Promise ? await sendResult : sendResult;
        if (accepted === false) {
          useChatStore.getState().setDraft(stateSessionId, text);
        }
        resolve?.(accepted !== false);
      })();
    }
  }, [
    ensureCurrentSessionIsAgentBuilder,
    readOnly,
    selectedPersona,
    sendWithAutoCompact,
    session?.agentBuilderOpen,
    session?.intent,
    stateSessionId,
    workspaceContextReady,
  ]);

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
      (session?.intent === "build-agent" && session.agentBuilderOpen !== false)
    ) {
      return;
    }

    void ensureCurrentSessionIsAgentBuilder({
      requireSelectedSkill: true,
    }).then((builderSession) => {
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
    });
  }, [
    ensureCurrentSessionIsAgentBuilder,
    hasSelectedAgentBuilderSkill,
    session?.agentBuilderOpen,
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

    const hasPendingProvider = pendingProviderId !== undefined;
    const hasPendingPersona = pendingPersonaId !== undefined;
    const hasPendingProject = pendingProjectId !== undefined;
    const hasPendingModel = pendingModelSelection !== undefined;

    if (
      hasPendingProvider ||
      hasPendingPersona ||
      hasPendingProject ||
      hasPendingModel
    ) {
      const nextProviderId = pendingProviderId ?? selectedProvider;
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
      const previousProviderId = previousSession?.providerId;
      const previousModelId = previousSession?.modelId;
      const previousModelName = previousSession?.modelName;
      const homePendingModel = pendingModelSelection ?? null;
      const homePendingProviderId =
        homePendingModel?.providerId ?? nextProviderId;
      const modelIntentRequestId = homePendingModel?.id
        ? createModelSelectionRequestId()
        : null;

      const patch: Partial<
        Pick<
          ChatSession,
          | "providerId"
          | "personaId"
          | "modelId"
          | "modelName"
          | "projectId"
          | "reasoningEffort"
        >
      > = {};

      if (hasPendingProvider) {
        patch.providerId = nextProviderId;
        patch.modelId = undefined;
        patch.modelName = undefined;
        patch.reasoningEffort = undefined;
      }
      if (homePendingModel?.id) {
        patch.providerId = homePendingProviderId;
        patch.modelId = homePendingModel.id;
        patch.modelName = homePendingModel.name;
        patch.reasoningEffort = undefined;
      }
      if (hasPendingPersona) {
        patch.personaId = nextPersonaId;
      }
      if (hasPendingProject) {
        patch.projectId = nextProjectId ?? null;
        void updateSessionProject(sessionId, nextProjectId ?? null).catch(
          console.error,
        );
      }

      if (homePendingModel?.id && modelIntentRequestId) {
        sessionStore.beginModelSelectionIntent(sessionId, {
          requestId: modelIntentRequestId,
          kind: "model",
          providerId: homePendingProviderId,
          modelId: homePendingModel.id,
          modelName: homePendingModel.name,
          previousProviderId,
          previousModelId,
          previousModelName,
        });
      }

      sessionStore.patchSession(sessionId, patch);
      // Consume pending state synchronously so a model-refresh-driven
      // re-render of this effect cannot replay it.
      setPendingProviderId(undefined);
      setPendingPersonaId(undefined);
      setPendingProjectId(undefined);
      setPendingModelSelection(undefined);

      void syncPendingHomeModelSelection({
        sessionId,
        nextProviderId,
        nextProject,
        workspacePath: activeWorkspace?.path,
        homePendingModel,
        homePendingProviderId,
        modelIntentRequestId,
        previous: {
          providerId: previousProviderId,
          modelId: previousModelId,
          modelName: previousModelName,
        },
        catalogEntries,
        prepareCurrentSession,
        applySessionModelSelection,
        setGlobalSelectedProvider,
        recreateSessionForProvider,
      });
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
    pendingPersonaId,
    pendingProjectId,
    pendingProviderId,
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
    queue: { ...queue, dismiss: dismissQueuedMessage },
    deferredWorkspaceRecord,
    cancelDeferredWorkspaceName: () =>
      readOnly ? false : cancelDeferredWorkspaceNaming(stateSessionId),
    createDeferredWorkspace: () =>
      readOnly ? false : chooseDeferredWorkspaceSetup(stateSessionId, true),
    submitDeferredWorkspaceName: (name: string) =>
      !readOnly && deferredWorkspaceRecord?.state.status === "naming"
        ? void createDeferredWorkspaces(
            stateSessionId,
            deferredWorkspaceRecord.recordId,
            name,
          )
        : undefined,
    skipDeferredWorkspace: () =>
      readOnly ? false : chooseDeferredWorkspaceSetup(stateSessionId, false),
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
    currentModelProviderId: effectiveModelSelection?.providerId ?? null,
    currentModelName: effectiveModelSelection?.name ?? null,
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
  };
}
