import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatAttachmentDraft } from "@/shared/types/messages";
import type { ChatSendOptions, ChatSkillDraft, ModelOption } from "../types";
import { INITIAL_TOKEN_STATE } from "@/shared/types/chat";
import { useChat } from "./useChat";
import { useAutoCompactPreferences } from "./useAutoCompactPreferences";
import { useMessageQueue } from "./useMessageQueue";
import { useChatStore } from "../stores/chatStore";
import {
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
import {
  composeSystemPrompt,
  formatArtifactFolderInstructions,
  formatPersonaSystemPrompt,
  resolveProjectDefaultArtifactRoot,
} from "@/features/projects/lib/chatProjectContext";
import { setStoredModelPreference } from "../lib/modelPreferences";
import { saveDefaultReasoningEffort } from "../lib/reasoningEffortPreferences";
import { applyLatestSessionConfig } from "../lib/sessionConfigRequests";
import {
  shouldAutoCompactContext,
  supportsContextAutoCompaction,
  supportsContextCompactionControls,
} from "../lib/autoCompact";
import { resolveSessionCwd } from "@/features/projects/lib/sessionCwdSelection";
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

interface UseChatSessionControllerOptions {
  sessionId: string | null;
  isHomeSession?: boolean;
  readOnly?: boolean;
  onMessageAccepted?: (sessionId: string) => void;
  onCreatePersonaRequested?: () => void;
}

const DRAFT_STORE_UPDATE_DEBOUNCE_MS = 300;
const PENDING_HOME_SESSION_ID = "__home_pending__";
const EMPTY_SKILL_DRAFTS: ChatSkillDraft[] = [];
const AGENT_BUILDER_MENTION_INVOCATION = /^@agent-builder\s*$/i;
const STEERING_SUPPORTED_AGENT_ID = "goose";

function isAgentBuilderMentionOnlyDraft(text: string): boolean {
  return AGENT_BUILDER_MENTION_INVOCATION.test(text.trim());
}

function movePendingHomeQueuedMessage(sessionId: string) {
  const chatState = useChatStore.getState();
  const pendingQueue =
    chatState.queuedMessageBySession[PENDING_HOME_SESSION_ID] ?? null;
  if (pendingQueue && !chatState.queuedMessageBySession[sessionId]) {
    chatState.enqueueMessage(sessionId, pendingQueue);
  }
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
  const pendingQueuedMessage = useChatStore(
    isHomeSession
      ? (s) => s.queuedMessageBySession[PENDING_HOME_SESSION_ID] ?? null
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
  const sessionCwd =
    activeWorkspace?.path ??
    session?.workingDir ??
    resolveProjectDefaultArtifactRoot(project);
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
  const workingContextPrompt = useMemo(() => {
    if (!activeWorkspace?.branch) return undefined;
    return `<active-working-context>\nActive branch: ${activeWorkspace.branch}\nWorking directory: ${activeWorkspace.path}\n</active-working-context>`;
  }, [activeWorkspace?.branch, activeWorkspace?.path]);
  const artifactFolderInstructions = useMemo(() => {
    if (project) return undefined;
    return formatArtifactFolderInstructions(sessionArtifactCwd);
  }, [project, sessionArtifactCwd]);
  const effectiveSystemPrompt = useMemo(
    () =>
      composeSystemPrompt(
        formatPersonaSystemPrompt(selectedPersona),
        workingContextPrompt,
      ),
    [selectedPersona, workingContextPrompt],
  );

  const prepareCurrentSession = useCallback(
    async (
      providerId: string,
      nextProject = project,
      nextWorkspacePath: string | null | undefined = activeWorkspace?.path ??
        session?.workingDir,
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
    [activeWorkspace?.path, project, session?.workingDir, sessionId],
  );
  const prepareCurrentSessionWithModel = useCallback(
    async (
      providerId: string,
      nextProject = project,
      nextWorkspacePath: string | null | undefined = activeWorkspace?.path ??
        session?.workingDir,
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
    [
      activeWorkspace?.path,
      prepareCurrentSession,
      project,
      session?.workingDir,
      sessionId,
    ],
  );
  const prepareSelectedProvider = useCallback(
    (providerId: string, options?: ModelSelectionApplyOptions) =>
      prepareCurrentSession(
        providerId,
        options?.nextProject ?? project,
        options?.nextWorkspacePath ??
          activeWorkspace?.path ??
          session?.workingDir,
        options?.requestId,
      ),
    [
      activeWorkspace?.path,
      prepareCurrentSession,
      project,
      session?.workingDir,
    ],
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
        options?.nextWorkspacePath ??
          activeWorkspace?.path ??
          session?.workingDir,
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
    [
      activeWorkspace?.path,
      isHomeSession,
      project,
      session?.workingDir,
      sessionId,
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

      activateSession(created.id);

      // Retire the stranded corpse now that we've migrated off it. The picker
      // only routes empty sessions here, so nothing is lost — but left in place
      // the dead session lingers in the list, re-triggers the same trap when
      // re-entered, and accumulates a new empty each time the user retries.
      // Archive rather than drop locally: the session exists on the backend, so
      // a local removal would reappear on the next loadSessions(). Best-effort —
      // recovery already succeeded, so a failed cleanup must not surface as a
      // recovery failure.
      const strandedSessionId = current?.id ?? sessionId;
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
      const providerModels = availableModels.filter(
        (model) => !model.providerId || model.providerId === providerId,
      );
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
    [availableModels],
  );
  const prepareSessionForPersona = useCallback(
    async (personaId?: string) => {
      const persona = personaId
        ? useAgentStore.getState().getPersonaById(personaId)
        : undefined;
      if (!persona?.provider) {
        return selectedProvider
          ? prepareCurrentSessionWithModel(
              selectedProvider,
              project,
              activeWorkspace?.path,
            )
          : undefined;
      }

      const matchingProvider = resolvePersonaProvider(persona, providers);
      if (!matchingProvider) {
        return selectedProvider
          ? prepareCurrentSessionWithModel(
              selectedProvider,
              project,
              activeWorkspace?.path,
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
          activeWorkspace?.path,
        );
      }

      const workingDir = await resolveSessionCwd(
        project,
        activeWorkspace?.path ?? session?.workingDir,
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
      activeWorkspace?.path,
      prepareCurrentSession,
      prepareCurrentSessionWithModel,
      project,
      providers,
      resolvePersonaModelSelection,
      selectedProvider,
      session?.workingDir,
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
      pendingDefaultReasoningEffortBySessionRef.current[sessionId] = value;

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
    [session?.reasoningEffort, sessionId],
  );

  const handleProjectChange = useCallback(
    (projectId: string | null) => {
      if (!sessionId) {
        setPendingProjectId(projectId);
        return;
      }
      void moveSessionToProject(sessionId, projectId, {
        providerId: selectedProvider,
        activeWorkspacePath: activeWorkspace?.path,
      }).catch((error) => {
        console.error("Failed to move session to project:", error);
      });
    },
    [activeWorkspace?.path, selectedProvider, sessionId],
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
              .catch((error) => {
                const liveStore = useChatSessionStore.getState();
                const intentStillMatches =
                  liveStore.getModelSelectionIntent(sessionId)?.requestId ===
                  requestId;
                if (!intentStillMatches) {
                  return;
                }
                liveStore.clearModelSelectionIntent(sessionId, requestId);
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
  const sendWithAutoCompact = useCallback(
    (
      text: string,
      overridePersona?: { id: string; name?: string },
      attachments?: ChatAttachmentDraft[],
      sendOptions?: ChatSendOptions,
      sessionOverride?: Pick<ChatSession, "intent" | "targetAgentPath">,
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

      if (isQueuedSendBlocked) {
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
      isQueuedSendBlocked,
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
  const queueChatState =
    sessionId && session?.creationState == null ? chatState : "thinking";
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
        if (!queue.queuedMessage) {
          queue.enqueue(text, personaId, attachments, sendOptions);
        }
        return true;
      }

      if (readOnly) {
        return false;
      }

      if (personaId && personaId !== selectedPersonaId) {
        handlePersonaChange(personaId);
        return new Promise<boolean>((resolve) => {
          deferredSend.current = { text, attachments, sendOptions, resolve };
        });
      }

      if (
        session?.intent !== "build-agent" &&
        isAgentBuilderSkillSendOptions(sendOptions)
      ) {
        return (async () => {
          const builderSession = await ensureCurrentSessionIsAgentBuilder();
          if (!builderSession) {
            return false;
          }

          if (
            (chatState !== "idle" || isQueuedSendBlocked) &&
            !queue.queuedMessage
          ) {
            recordDraftPreservingSubmission(sessionId, text);
            queue.enqueue(text, personaId, attachments, sendOptions);
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

      if (
        (chatState !== "idle" || isQueuedSendBlocked) &&
        !queue.queuedMessage
      ) {
        recordDraftPreservingSubmission(sessionId, text);
        queue.enqueue(text, personaId, attachments, sendOptions);
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
        sendOptions,
      );
    },
    [
      chatState,
      ensureCurrentSessionIsAgentBuilder,
      handlePersonaChange,
      isQueuedSendBlocked,
      queue,
      readOnly,
      recordDraftPreservingSubmission,
      session?.intent,
      sessionId,
      selectedPersona,
      selectedPersonaId,
      sendWithAutoCompact,
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
      const { text, attachments, sendOptions, resolve } = deferredSend.current;
      deferredSend.current = null;
      if (readOnly) {
        useChatStore.getState().setDraft(stateSessionId, text);
        resolve?.(false);
        return;
      }

      void (async () => {
        const builderSession =
          session?.intent !== "build-agent" &&
          isAgentBuilderSkillSendOptions(sendOptions)
            ? await ensureCurrentSessionIsAgentBuilder()
            : undefined;
        if (
          isAgentBuilderSkillSendOptions(sendOptions) &&
          session?.intent !== "build-agent" &&
          !builderSession
        ) {
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
    session?.intent,
    stateSessionId,
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
  const draftValue = sessionId ? sessionDraftValue : pendingDraftValue;
  const storedSelectedSkills = sessionId
    ? sessionSkillDrafts
    : pendingSkillDrafts;
  const selectedSkills =
    session?.intent === "build-agent"
      ? ensureAgentBuilderSkillDraft(storedSelectedSkills)
      : storedSelectedSkills;
  const hasSelectedAgentBuilderSkill =
    hasAgentBuilderSkillDraft(selectedSkills);
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
      useChatStore
        .getState()
        .setSkillDrafts(
          stateSessionId,
          session?.intent === "build-agent"
            ? ensureAgentBuilderSkillDraft(skills)
            : skills,
        );
    },
    [session?.intent, stateSessionId],
  );

  useEffect(() => {
    if (
      !sessionId ||
      session?.intent === "build-agent" ||
      !hasSelectedAgentBuilderSkill
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
    void pendingQueuedMessage;

    const chatStateNow = useChatStore.getState();
    const pendingDraft =
      chatStateNow.draftsBySession[PENDING_HOME_SESSION_ID] ?? "";
    const pendingSkills =
      chatStateNow.skillDraftsBySession[PENDING_HOME_SESSION_ID] ?? [];

    if (pendingDraft && !chatStateNow.draftsBySession[sessionId]) {
      chatStateNow.setDraft(sessionId, pendingDraft);
    }
    if (
      pendingSkills.length > 0 &&
      !chatStateNow.skillDraftsBySession[sessionId]?.length
    ) {
      chatStateNow.setSkillDrafts(sessionId, pendingSkills);
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
      });
    }

    movePendingHomeQueuedMessage(sessionId);
    useChatStore.getState().clearDraft(PENDING_HOME_SESSION_ID);
    useChatStore.getState().clearSkillDrafts(PENDING_HOME_SESSION_ID);
    useChatStore.getState().dismissQueuedMessage(PENDING_HOME_SESSION_ID);
    useChatStore.getState().cleanupSession(PENDING_HOME_SESSION_ID);
  }, [
    activeWorkspace?.path,
    applySessionModelSelection,
    catalogEntries,
    isHomeSession,
    pendingDraftValue,
    pendingSkillDrafts,
    pendingModelSelection,
    pendingPersonaId,
    pendingProjectId,
    pendingProviderId,
    pendingQueuedMessage,
    prepareCurrentSession,
    selectedProvider,
    setGlobalSelectedProvider,
    flushPendingDraftStoreWrite,
    session?.personaId,
    session?.projectId,
    sessionId,
  ]);

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
    queue,
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
    selectedSkills,
    handleSkillsChange,
    scrollTarget,
    handleScrollTargetHandled,
    projectMetadataPending,
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
