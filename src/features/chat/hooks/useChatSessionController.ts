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
  resolveProjectDefaultArtifactRoot,
} from "@/features/projects/lib/chatProjectContext";
import { setStoredModelPreference } from "../lib/modelPreferences";
import { applyLatestSessionConfig } from "../lib/sessionConfigRequests";
import {
  shouldAutoCompactContext,
  supportsContextAutoCompaction,
  supportsContextCompactionControls,
} from "../lib/autoCompact";
import { resolveSessionCwd } from "@/features/projects/lib/sessionCwdSelection";
import { useResolvedAgentModelPicker } from "./useResolvedAgentModelPicker";
import { updateSessionProject } from "@/shared/api/acpApi";
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
  onMessageAccepted?: (sessionId: string) => void;
  onCreatePersonaRequested?: () => void;
}

const PENDING_HOME_SESSION_ID = "__home_pending__";
const EMPTY_SKILL_DRAFTS: ChatSkillDraft[] = [];

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
  const pendingDraftValue = useChatStore(
    (s) => s.draftsBySession[PENDING_HOME_SESSION_ID] ?? "",
  );
  const pendingSkillDrafts = useChatStore(
    (s) =>
      s.skillDraftsBySession[PENDING_HOME_SESSION_ID] ?? EMPTY_SKILL_DRAFTS,
  );
  const pendingQueuedMessage = useChatStore(
    (s) => s.queuedMessageBySession[PENDING_HOME_SESSION_ID] ?? null,
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
    pendingProviderId ??
    session?.providerId ??
    project?.preferredProvider ??
    globalSelectedProvider;
  const selectedPersonaId =
    pendingPersonaId !== undefined
      ? pendingPersonaId
      : (session?.personaId ?? null);
  const selectedPersona = personas.find(
    (persona) => persona.id === selectedPersonaId,
  );
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
  const effectiveSystemPrompt = useMemo(
    () =>
      composeSystemPrompt(selectedPersona?.systemPrompt, workingContextPrompt),
    [selectedPersona?.systemPrompt, workingContextPrompt],
  );

  const prepareCurrentSession = useCallback(
    async (
      providerId: string,
      nextProject = project,
      nextWorkspacePath: string | null | undefined = activeWorkspace?.path,
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

      useChatSessionStore.getState().patchSession(sessionId, { workingDir });
      return true;
    },
    [activeWorkspace?.path, project, sessionId],
  );
  const prepareCurrentSessionWithModel = useCallback(
    async (
      providerId: string,
      nextProject = project,
      nextWorkspacePath: string | null | undefined = activeWorkspace?.path,
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
      });
      return true;
    },
    [activeWorkspace?.path, prepareCurrentSession, project, sessionId],
  );
  const prepareSelectedProvider = useCallback(
    (providerId: string, options?: ModelSelectionApplyOptions) =>
      prepareCurrentSession(
        providerId,
        options?.nextProject ?? project,
        options?.nextWorkspacePath ?? activeWorkspace?.path,
        options?.requestId,
      ),
    [activeWorkspace?.path, prepareCurrentSession, project],
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
        options?.nextWorkspacePath ?? activeWorkspace?.path,
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
      useChatSessionStore.getState().patchSession(sessionId, {
        workingDir,
        modelId: modelSelection.id,
        modelName: modelSelection.name,
      });
      return true;
    },
    [activeWorkspace?.path, project, sessionId],
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
  });

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

      useChatStore.getState().resetTokenState(stateSessionId);
      handleProviderChange(providerId);
    },
    [handleProviderChange, selectedProvider, stateSessionId],
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
      useChatStore.getState().resetTokenState(stateSessionId);
      handleModelChange(modelId, model);
    },
    [
      effectiveModelSelection?.id,
      effectiveModelSelection?.providerId,
      handleModelChange,
      stateSessionId,
    ],
  );

  const handleProjectChange = useCallback(
    (projectId: string | null) => {
      if (!sessionId) {
        setPendingProjectId(projectId);
        return;
      }
      const nextProject =
        projectId == null
          ? null
          : (useProjectStore
              .getState()
              .projects.find((candidate) => candidate.id === projectId) ??
            null);

      useChatSessionStore.getState().patchSession(sessionId, { projectId });

      void updateSessionProject(sessionId, projectId).catch(console.error);

      if (!selectedProvider) {
        return;
      }
      void prepareCurrentSessionWithModel(
        selectedProvider,
        nextProject,
        activeWorkspace?.path,
      ).catch((error) => {
        console.error("Failed to update ACP session working directory:", error);
      });
    },
    [
      activeWorkspace?.path,
      prepareCurrentSessionWithModel,
      selectedProvider,
      sessionId,
    ],
  );

  const handlePersonaChange = useCallback(
    (personaId: string | null) => {
      if (personaId === selectedPersonaId) {
        return;
      }

      const persona = personas.find((candidate) => candidate.id === personaId);

      if (persona?.provider) {
        const matchingProvider = providers.find(
          (provider) =>
            provider.id === persona.provider ||
            provider.label.toLowerCase().includes(persona.provider ?? ""),
        );
        if (matchingProvider) {
          if (!sessionId) {
            setPendingProviderId(matchingProvider.id);
            setPendingModelSelection(undefined);
            setGlobalSelectedProvider(matchingProvider.id);
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
      personas,
      providers,
      sessionId,
      selectedPersonaId,
      setGlobalSelectedProvider,
    ],
  );

  useEffect(() => {
    if (
      selectedPersonaId !== null &&
      personas.length > 0 &&
      !personas.find((persona) => persona.id === selectedPersonaId)
    ) {
      if (sessionId) {
        useChatSessionStore
          .getState()
          .patchSession(sessionId, { personaId: undefined });
      } else {
        setPendingPersonaId(undefined);
      }
    }
  }, [personas, selectedPersonaId, sessionId]);

  const personaInfo = selectedPersona
    ? { id: selectedPersona.id, name: selectedPersona.displayName }
    : undefined;
  const {
    messages,
    chatState,
    tokenState,
    sendMessage,
    compactConversation,
    stopStreaming,
    streamingMessageId,
  } = useChat(
    stateSessionId,
    selectedProvider,
    effectiveSystemPrompt,
    personaInfo,
    {
      onMessageAccepted: sessionId ? onMessageAccepted : undefined,
      ensurePrepared: selectedProvider
        ? () =>
            prepareCurrentSessionWithModel(
              selectedProvider,
              project,
              activeWorkspace?.path,
            )
        : undefined,
    },
  );
  const resolvedTokenState = tokenState ?? INITIAL_TOKEN_STATE;
  const supportsAutoCompactContext =
    supportsContextAutoCompaction(selectedAgentId);
  const supportsCompactionControls =
    supportsContextCompactionControls(selectedAgentId);
  const isCompactingContext = chatState === "compacting";
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
    ) => {
      if (!canAutoCompactBeforeSend(overridePersona)) {
        if (sendOptions) {
          void sendMessage(text, overridePersona, attachments, sendOptions);
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

        if (sendOptions) {
          void sendMessage(text, overridePersona, attachments, sendOptions);
        } else {
          void sendMessage(text, overridePersona, attachments);
        }
        return true;
      })();
    },
    [canAutoCompactBeforeSend, compactConversation, sendMessage],
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
  const queue = useMessageQueue(
    stateSessionId,
    sessionId ? chatState : "thinking",
    sendWithAutoCompact,
  );

  const handleSend = useCallback(
    (
      text: string,
      personaId?: string,
      attachments?: ChatAttachmentDraft[],
      sendOptions?: ChatSendOptions,
    ) => {
      if (!sessionId) {
        if (!queue.queuedMessage) {
          queue.enqueue(text, personaId, attachments, sendOptions);
        }
        return true;
      }

      if (personaId && personaId !== selectedPersonaId) {
        handlePersonaChange(personaId);
        return new Promise<boolean>((resolve) => {
          deferredSend.current = { text, attachments, sendOptions, resolve };
        });
      }

      if (chatState !== "idle" && !queue.queuedMessage) {
        queue.enqueue(text, personaId, attachments, sendOptions);
        return true;
      }

      return sendWithAutoCompact(text, undefined, attachments, sendOptions);
    },
    [
      chatState,
      handlePersonaChange,
      queue,
      sessionId,
      selectedPersonaId,
      sendWithAutoCompact,
    ],
  );

  useEffect(() => {
    if (deferredSend.current && selectedPersona) {
      const { text, attachments, sendOptions, resolve } = deferredSend.current;
      deferredSend.current = null;
      const sendResult = sendWithAutoCompact(
        text,
        undefined,
        attachments,
        sendOptions,
      );
      if (sendResult instanceof Promise) {
        void sendResult.then((accepted) => {
          if (accepted === false) {
            useChatStore.getState().setDraft(stateSessionId, text);
          }
          resolve?.(accepted !== false);
        });
        return;
      }
      resolve?.(true);
    }
  }, [selectedPersona, sendWithAutoCompact, stateSessionId]);

  const handleCreatePersona = useCallback(() => {
    if (onCreatePersonaRequested) {
      onCreatePersonaRequested();
      return;
    }
    useAgentStore.getState().openPersonaEditor();
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
  const selectedSkills = sessionId ? sessionSkillDrafts : pendingSkillDrafts;
  const handleDraftChange = useCallback(
    (text: string) => {
      useChatStore.getState().setDraft(stateSessionId, text);
    },
    [stateSessionId],
  );
  const handleSkillsChange = useCallback(
    (skills: typeof selectedSkills) => {
      useChatStore.getState().setSkillDrafts(stateSessionId, skills);
    },
    [stateSessionId],
  );
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
    if (!sessionId) {
      return;
    }

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
          "providerId" | "personaId" | "modelId" | "modelName" | "projectId"
        >
      > = {};

      if (hasPendingProvider) {
        patch.providerId = nextProviderId;
        patch.modelId = undefined;
        patch.modelName = undefined;
      }
      if (homePendingModel?.id) {
        patch.providerId = homePendingProviderId;
        patch.modelId = homePendingModel.id;
        patch.modelName = homePendingModel.name;
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
      // Consume pending state synchronously so an inventory-refresh-driven
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
      supportsCompactionControls && messages.length > 0 && chatState === "idle",
    isCompactingContext,
    supportsAutoCompactContext,
    supportsCompactionControls,
    isContextUsageReady:
      hasContextUsageSnapshot && resolvedTokenState.contextLimit > 0,
    isLoadingHistory,
    queue,
    handleSend,
    draftValue,
    handleDraftChange,
    selectedSkills,
    handleSkillsChange,
    scrollTarget,
    handleScrollTargetHandled,
    projectMetadataPending,
    personas,
    selectedPersonaId,
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
    handlePickerOpen,
    selectedProjectId: effectiveProjectId,
    availableProjects,
    handleProjectChange,
  };
}
