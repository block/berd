import { useAgentStore } from "@/features/agents/stores/agentStore";
import { listPersonas } from "@/shared/api/agents";
import type { Persona } from "@/shared/types/agents";
import { listProjects } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { resolveSessionCwd } from "@/features/projects/lib/sessionCwdSelection";
import { listSkills } from "@/features/skills/api/skills";
import { formatAvailableSkillsCatalogPrompt } from "@/features/skills/lib/skillChatPrompt";
import {
  composeSystemPrompt,
  formatPersonaSystemPrompt,
} from "@/features/projects/lib/chatProjectContext";

import { loadWorkspaceInstructionFiles } from "@/features/chat/api/workspaceContext";
import { sendPromptInBackground } from "@/features/chat/lib/backgroundSend";
import { composeBuilderSendOptions } from "@/features/chat/hooks/useBuilderSendInterceptor";
import { getAgentBuilderQueuePreparedTargetPath } from "@/features/chat/lib/agentBuilderQueueReadiness";
import { isFirstCommittedUserMessage } from "@/features/chat/lib/chatFirstMessage";
import {
  trackChatMessageSent,
  trackChatSessionStarted,
} from "@/features/chat/lib/chatTelemetry";
import { QueuedSessionNotReadyError } from "@/features/chat/lib/queuedMessageReadiness";
import { isRemoteSession } from "@/features/chat/lib/remoteSession";
import { loadSessionMessages } from "@/features/chat/lib/sessionActivation";
import {
  SessionDispatchContentionError,
  SessionDispatchCreationIncompleteError,
  SessionDispatchMissingError,
  SessionDispatchUnresolvedError,
} from "@/features/chat/lib/sessionDispatchAcquisition";
import {
  acquireSessionDispatchTarget,
  transitionSessionTarget,
} from "@/features/chat/lib/sessionTargetCoordinator";
import { applyPendingSessionWorkspaceActivation } from "@/features/chat/lib/sessionWorkspaceActivation";
import {
  formatIncludedWorkspacesPrompt,
  getWorkspaceAttachments,
} from "@/features/chat/lib/workspaceAttachments";
import { formatWorkspaceInstructionsPrompt } from "@/features/chat/lib/workspaceContextPrompt";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import type { QueuedMessageRecord } from "@/features/chat/stores/chatStore";

import {
  sameSessionExecutionTarget,
  type SessionExecutionTarget,
} from "@/features/chat/lib/sessionExecutionTarget";
import { gooseServeSelectionFromExecutionTarget } from "@/features/chat/lib/gooseServeExecutionTarget";
import { perfLog } from "@/shared/lib/perfLog";

async function findPersona(personaId: string): Promise<Persona> {
  const cached = useAgentStore.getState().getPersonaById(personaId);
  if (cached) {
    return cached;
  }

  const personas = await listPersonas();
  useAgentStore.getState().setPersonas(personas);
  const persona = personas.find((candidate) => candidate.id === personaId);
  if (!persona) {
    throw new Error(`No agent "${personaId}".`);
  }
  return persona;
}

function targetMatchesOrMaterializes(
  actual: SessionExecutionTarget | undefined,
  expected: SessionExecutionTarget,
): boolean {
  return (
    sameSessionExecutionTarget(actual, expected) ||
    (expected.modelId === undefined &&
      actual?.harnessId === expected.harnessId &&
      actual.modelProviderId === expected.modelProviderId)
  );
}

function assertSessionExecutionTarget(
  sessionId: string,
  expectedTarget: SessionExecutionTarget,
): void {
  if (
    targetMatchesOrMaterializes(
      useChatSessionStore.getState().getSession(sessionId)?.executionTarget,
      expectedTarget,
    )
  ) {
    return;
  }
  throw new Error("Session preparation was superseded by a newer selection.");
}

function hasUiOwnedUnresolvedTarget(session?: ChatSession): boolean {
  return session?.executionTargetSource === "ui" && !session.executionTarget;
}

export {
  SessionDispatchContentionError,
  SessionDispatchCreationIncompleteError,
  SessionDispatchMissingError,
  SessionDispatchUnresolvedError,
} from "@/features/chat/lib/sessionDispatchAcquisition";

async function hydrateSessionForBackgroundSend(
  sessionId: string,
): Promise<boolean> {
  const loaded = await loadSessionMessages(sessionId);
  if (!loaded) {
    throw new Error("Failed to load the target session before sending.");
  }
  await applyPendingSessionWorkspaceActivation(sessionId);
  return Boolean(useChatSessionStore.getState().getSession(sessionId));
}

export async function acquireExistingSessionForBackgroundSend(
  sessionId: string,
) {
  const sessionBeforeHydration = useChatSessionStore
    .getState()
    .getSession(sessionId);
  if (!sessionBeforeHydration) {
    return { status: "session-missing" } as const;
  }
  // Backend creation is still in flight (or has failed), so this id is a
  // renderer-local draft. `loadSessionMessages` reports success for it —
  // "nothing to load" is not a failure there — which would let preparation
  // walk on to `acpApi.loadSession` with an id the backend never issued.
  const { creationState } = sessionBeforeHydration;
  if (creationState) {
    return { status: "creation-incomplete", creationState } as const;
  }
  // Claim the dispatch target before hydrating, not after. Every notification
  // that arrives while `session/load` is in flight is classified as replay, so
  // a sender that dispatched during our hydration would have its live turn
  // buffered as history and then dropped when the load resolves and replaces
  // the transcript. Holding the lease across the load publishes that window:
  // other senders see contention and wait for the release instead of
  // dispatching into it. Hydration under a held lease is expected — the target
  // coordinator either absorbs a matching observation or defers it to release.
  const acquisition = acquireSessionDispatchTarget(sessionId);
  if (acquisition.status === "unresolved") {
    // The store holds no execution target yet, so there is nothing to lease:
    // the `session/load` replay is what hydrates the target for a session
    // this renderer has never activated (berdctl can address one directly).
    // Hydrate first and lease the replayed target. The unleased load this
    // reopens covers only targetless sessions, which no queued drain attempts
    // — `isQueuedMessageTargetAttemptable` requires an execution target.
    if (!(await hydrateSessionForBackgroundSend(sessionId))) {
      return { status: "session-missing" } as const;
    }
    return acquireSessionDispatchTarget(sessionId);
  }
  if (acquisition.status !== "acquired") {
    return acquisition;
  }
  try {
    if (!(await hydrateSessionForBackgroundSend(sessionId))) {
      acquisition.release();
      return { status: "session-missing" } as const;
    }
    return acquisition;
  } catch (error) {
    acquisition.release();
    throw error;
  }
}

export async function prepareExistingSessionForBackgroundSend(
  sessionId: string,
  options: {
    preserveWorkingDir?: boolean;
    executionTarget?: SessionExecutionTarget;
    dispatchToken?: symbol;
    skipPersonaLookup?: boolean;
  } = {},
): Promise<{
  providerId: string;
  executionTarget: SessionExecutionTarget;
  persona?: Pick<Persona, "id" | "displayName" | "systemPrompt">;
}> {
  const session = useChatSessionStore.getState().getSession(sessionId);
  if (!session) {
    throw new Error(`No session "${sessionId}".`);
  }
  const [project, persona] = await Promise.all([
    session.projectId
      ? listProjects().then((projects) => {
          useProjectStore.getState().replaceProjectsFromBackend(projects);
          const match = projects.find(
            (candidate) => candidate.id === session.projectId,
          );
          if (!match) {
            throw new Error(`No project "${session.projectId}".`);
          }
          return match;
        })
      : null,
    !options.skipPersonaLookup && session.personaId
      ? findPersona(session.personaId)
      : null,
  ]);
  const activeWorkspacePath = options.preserveWorkingDir
    ? session.workingDir
    : (useChatSessionStore.getState().activeWorkspaceBySession[sessionId]
        ?.path ?? session.workingDir);
  // Remote sessions: the cwd names a directory on the SSH host, so the local
  // resolve_path/artifact-root machinery must not touch it — pass the stored
  // workingDir through verbatim (mirrors sessionActivation's load guard).
  const workingDir = isRemoteSession(session)
    ? (session.workingDir ?? "")
    : await resolveSessionCwd(project, activeWorkspacePath);
  const liveSessionAtSubmit = useChatSessionStore
    .getState()
    .getSession(sessionId);
  const liveTargetAtSubmit = liveSessionAtSubmit?.executionTarget;
  if (
    options.executionTarget &&
    (hasUiOwnedUnresolvedTarget(liveSessionAtSubmit) ||
      (liveTargetAtSubmit &&
        !sameSessionExecutionTarget(
          options.executionTarget,
          liveTargetAtSubmit,
        )))
  ) {
    throw new Error("Session preparation was superseded by a newer selection.");
  }
  const executionTarget = options.executionTarget ?? liveTargetAtSubmit;
  if (!executionTarget) {
    throw new Error(
      "Select a model before sending to this unresolved session.",
    );
  }
  const { providerId } =
    gooseServeSelectionFromExecutionTarget(executionTarget);
  if (!providerId) {
    throw new Error("Session execution target requires a provider boundary.");
  }

  const result = await transitionSessionTarget({
    sessionId,
    target: executionTarget,
    workingDir,
    dispatchToken: options.dispatchToken,
  });
  if (!result.applied) {
    throw new Error("Session preparation was superseded by a newer selection.");
  }
  const preparedExecutionTarget = result.target;
  const { providerId: resolvedProviderId } =
    gooseServeSelectionFromExecutionTarget(preparedExecutionTarget);
  if (!resolvedProviderId) {
    throw new Error("Session execution target requires a provider boundary.");
  }
  return {
    providerId: resolvedProviderId,
    executionTarget: preparedExecutionTarget,
    persona: persona ?? undefined,
  };
}

export async function sendQueuedPromptToExistingSessionInBackground(
  sessionId: string,
  queuedMessage: QueuedMessageRecord & { kind: "transport-ready" },
  beforeUserMessageCommitted?: () => void,
  onPromptDispatched?: () => void,
): Promise<void> {
  let preparedBuilderTargetPath: string | undefined;
  const assertAgentBuilderPreparationReady = () => {
    const targetPath = getAgentBuilderQueuePreparedTargetPath(
      queuedMessage,
      useChatSessionStore.getState().getSession(sessionId),
    );
    if (
      targetPath === null ||
      (preparedBuilderTargetPath !== undefined &&
        targetPath !== preparedBuilderTargetPath)
    ) {
      throw new QueuedSessionNotReadyError();
    }
    return targetPath;
  };
  assertAgentBuilderPreparationReady();
  const acquisition = await acquireExistingSessionForBackgroundSend(sessionId);
  if (acquisition.status === "contended") {
    throw new SessionDispatchContentionError(acquisition.waiter);
  }
  if (acquisition.status === "unresolved") {
    throw new SessionDispatchUnresolvedError();
  }
  if (acquisition.status === "session-missing") {
    throw new SessionDispatchMissingError(sessionId);
  }
  if (acquisition.status === "creation-incomplete") {
    throw new SessionDispatchCreationIncompleteError(acquisition.creationState);
  }
  const targetLease = acquisition;
  try {
    const { payload } = queuedMessage;
    const payloadPersonaIntent = payload.persona;
    const payloadPersona =
      payloadPersonaIntent.kind === "persona"
        ? await findPersona(payloadPersonaIntent.id).catch((error) => {
            if (!payloadPersonaIntent.name) throw error;
            return {
              id: payloadPersonaIntent.id,
              displayName: payloadPersonaIntent.name,
              systemPrompt: "",
              isBuiltin: false,
              writable: false,
            } satisfies Persona;
          })
        : undefined;
    const {
      providerId,
      executionTarget: preparedExecutionTarget,
      persona: sessionPersona,
    } = await prepareExistingSessionForBackgroundSend(sessionId, {
      preserveWorkingDir: queuedMessage.releasedFromDeferred,
      skipPersonaLookup: payload.persona.kind !== "inherit",
      executionTarget: targetLease.target,
      dispatchToken: targetLease.token,
    });
    const persona =
      payloadPersonaIntent.kind === "none"
        ? undefined
        : payloadPersona
          ? {
              ...payloadPersona,
              displayName:
                payloadPersonaIntent.kind === "persona"
                  ? (payloadPersonaIntent.name ?? payloadPersona.displayName)
                  : payloadPersona.displayName,
            }
          : sessionPersona;
    const session = useChatSessionStore.getState().getSession(sessionId);
    const workspacePaths = session
      ? getWorkspaceAttachments(session)
          .filter((attachment) => attachment.source !== "excluded")
          .map((attachment) => attachment.path)
      : [];
    const [instructionFiles, skills] = await Promise.all([
      loadWorkspaceInstructionFiles(workspacePaths).catch((error) => {
        console.warn(
          "Failed to load workspace instructions for queued send:",
          error,
        );
        return [];
      }),
      listSkills(workspacePaths, { providerId }).catch((error) => {
        console.warn("Failed to list skills for queued send:", error);
        return [];
      }),
    ]);
    const workspaceContextPrompt = session
      ? composeSystemPrompt(
          formatIncludedWorkspacesPrompt(session),
          formatWorkspaceInstructionsPrompt(instructionFiles),
          formatAvailableSkillsCatalogPrompt(skills),
        )
      : undefined;
    const sessionBeforeSend = useChatSessionStore
      .getState()
      .getSession(sessionId);
    preparedBuilderTargetPath = assertAgentBuilderPreparationReady();
    const sendOptions = composeBuilderSendOptions(
      sessionBeforeSend,
      payload.sendOptions ?? {},
    );
    const personaSystemPrompt =
      sendOptions.capturedPersonaSystemPrompt ??
      formatPersonaSystemPrompt(persona);
    const executionSystemPrompt =
      sendOptions.executionSystemPrompt ??
      composeSystemPrompt(
        personaSystemPrompt,
        sendOptions.systemPrompt ?? workspaceContextPrompt,
      );
    assertSessionExecutionTarget(sessionId, preparedExecutionTarget);
    // A foreground composer send that was deferred for workspace setup is
    // dispatched here, not by its controller, so its `berd_chat` send
    // telemetry anchors to this dispatch's user-message commit — the same
    // anchor the foreground path uses (fireChatSendTelemetry in
    // useChatSessionController): a pre-commit failure emits nothing, and each
    // accepted send emits exactly once. The surface rides in the payload
    // (`telemetrySourceSurface`); berdctl/background payloads never carry one
    // and stay untracked by design.
    const telemetrySourceSurface = sendOptions.telemetrySourceSurface;
    const fireSendTelemetry = telemetrySourceSurface
      ? () => {
          // Observation only, structurally (matching fireChatSendTelemetry):
          // this runs inside sendCore's commit callback, where a throw would
          // reject a send the backend already accepted and skip the state
          // transitions that follow the commit.
          try {
            // Post-commit read, matching the foreground anchor: the user
            // message this send committed is already in the transcript, so
            // "first" means it is the only user message there, once the
            // session's history has landed (see chatFirstMessage).
            const isFirstMessage = isFirstCommittedUserMessage(sessionId);
            const hasPersona = Boolean(persona);
            const provider = preparedExecutionTarget.harnessId;
            const model = preparedExecutionTarget.modelId;
            if (isFirstMessage) {
              trackChatSessionStarted({
                sessionId,
                sourceSurface: telemetrySourceSurface,
                hasProject: Boolean(
                  useChatSessionStore.getState().getSession(sessionId)
                    ?.projectId,
                ),
                hasPersona,
                provider,
                model,
              });
            }
            trackChatMessageSent({
              sessionId,
              isFirstMessage,
              hasAttachments: (payload.attachments?.length ?? 0) > 0,
              hasPersona,
              provider,
              model,
            });
          } catch (error) {
            perfLog(`[telemetry] chat send telemetry failed: ${String(error)}`);
          }
        }
      : undefined;
    await sendPromptInBackground(
      sessionId,
      payload.text,
      providerId,
      persona ?? undefined,
      {
        ...sendOptions,
        executionSystemPrompt,
      },
      payload.attachments,
      () => {
        assertAgentBuilderPreparationReady();
        beforeUserMessageCommitted?.();
      },
      fireSendTelemetry,
      () => assertSessionExecutionTarget(sessionId, preparedExecutionTarget),
      onPromptDispatched,
    );
  } finally {
    targetLease.release();
  }
}
