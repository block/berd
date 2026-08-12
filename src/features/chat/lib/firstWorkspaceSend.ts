import {
  isAskWorktreeStartupMode,
  isWorktreeStartupMode,
  type ProjectInfo,
  type ProjectWorkspace,
} from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { getWorkspaceRepository } from "@/features/workspaces/workspaceRepository";
import {
  planProjectChatWorkspaces,
  planProjectChatWorkspacesAsIs,
  projectRequiresStartupWorkspaceName,
  rollbackProjectChatWorkspacePlan,
} from "@/features/projects/lib/projectChatWorkspaces";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import {
  getRelativeWorkspacePath,
  getWorkspaceAttachments,
  isSameWorkspacePath,
} from "./workspaceAttachments";
import { transitionSessionTarget } from "./sessionTargetCoordinator";
import type { SessionExecutionTarget } from "./sessionExecutionTarget";
import { isAdmittedQueuedMessagePayload } from "./admittedSend";
import {
  useChatStore,
  type QueuedMessagePayload,
  type QueuedMessageRecord,
} from "../stores/chatStore";
import { useChatSessionStore } from "../stores/chatSessionStore";

export const UNRESOLVED_DEFERRED_SEND_ERROR =
  "Select a model before sending to this unresolved session.";
const WORKSPACE_SESSION_PROMOTION_TIMEOUT_MS = 30_000;

function projectWorkspaceConfigurationRevision(
  workspaces: readonly ProjectWorkspace[],
): string {
  return workspaces
    .map((workspace) => ({
      path: workspace.path.replace(/\\/g, "/").replace(/\/+$/, ""),
      startupMode: workspace.startupMode,
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({ path, startupMode }) => `${path}\0${startupMode}`)
    .join("\n");
}

function projectWorkspaceConfigurationsEqual(
  left: readonly ProjectWorkspace[],
  right: readonly ProjectWorkspace[],
): boolean {
  return (
    projectWorkspaceConfigurationRevision(left) ===
    projectWorkspaceConfigurationRevision(right)
  );
}

export interface DeferredWorkspaceSend {
  type: "workspace-first-send";
  status: "choice" | "naming" | "creating" | "held" | "failed";
  projectId: string;
  desired: ProjectWorkspace[];
  cancelBuilderDraftPath?: string;
  configurationRevision?: string;
  error?: string;
}

export interface WorkspaceNameRequest {
  workspaces: ProjectWorkspace[];
  submit: (name: string | null) => void;
  cancel: () => void;
}

function attachmentMatches(
  attachment: WorkspaceAttachment,
  workspace: ProjectWorkspace,
): boolean {
  if (attachment.source === "excluded") return false;
  if (attachment.source === "selected") {
    return isSameWorkspacePath(attachment.path, workspace.path);
  }
  if (attachment.source === "inferred") {
    return (
      workspace.startupMode === "none" &&
      isSameWorkspacePath(attachment.path, workspace.path)
    );
  }
  const requiredCleanup = isWorktreeStartupMode(workspace.startupMode)
    ? "worktree"
    : workspace.startupMode === "branch"
      ? "branch"
      : null;
  if (requiredCleanup && attachment.lifecycle?.cleanup !== requiredCleanup) {
    return false;
  }
  const repository =
    attachment.lifecycle?.repositoryPath ?? attachment.repositoryPath;
  const root = attachment.lifecycle?.worktreePath ?? attachment.worktreePath;
  const workspaceRoot = workspace.worktreePath ?? workspace.repositoryPath;
  return Boolean(
    repository &&
      workspace.repositoryPath &&
      isSameWorkspacePath(repository, workspace.repositoryPath) &&
      getRelativeWorkspacePath(attachment.path, root) ===
        getRelativeWorkspacePath(workspace.path, workspaceRoot),
  );
}

/** Exact equality: every included attachment and every configured workspace pair once. */
export function workspaceAttachmentsEqualConfiguration(
  desired: readonly ProjectWorkspace[],
  actual: readonly WorkspaceAttachment[] | null | undefined,
): boolean {
  const remaining = (actual ?? []).filter(
    (attachment) => attachment.source !== "excluded",
  );
  if (remaining.length !== desired.length) return false;
  return desired.every((workspace) => {
    const index = remaining.findIndex((attachment) =>
      attachmentMatches(attachment, workspace),
    );
    if (index < 0) return false;
    remaining.splice(index, 1);
    return true;
  });
}

function resolveDeferredSessionId(
  originalSessionId: string,
  recordId?: string,
): string | null {
  const sessions = useChatSessionStore.getState().sessions;
  const session = sessions.find(
    (candidate) =>
      candidate.id === originalSessionId ||
      candidate.clientSessionId === originalSessionId,
  );
  if (!recordId) return session?.id ?? null;
  if (session) {
    const record =
      useChatStore.getState().queuedMessageBySession[session.id]?.[0];
    if (record?.recordId === recordId) return session.id;
  }
  const queuedEntry = Object.entries(
    useChatStore.getState().queuedMessageBySession,
  ).find(([, records]) =>
    records.some((record) => record.recordId === recordId),
  );
  return queuedEntry?.[0] ?? null;
}

async function waitForPromotedSessionId(
  originalSessionId: string,
): Promise<string | null> {
  const resolve = (): string | null | undefined => {
    const session = useChatSessionStore
      .getState()
      .sessions.find(
        (candidate) =>
          candidate.id === originalSessionId ||
          candidate.clientSessionId === originalSessionId,
      );
    if (!session || session.archivedAt || session.creationState === "failed") {
      return null;
    }
    return session.creationState === "pending" ||
      session.id === originalSessionId
      ? undefined
      : session.id;
  };

  const initial = resolve();
  if (initial !== undefined) return initial;
  return new Promise((finish) => {
    let settled = false;
    const complete = (result: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      unsubscribe();
      finish(result);
    };
    const unsubscribe = useChatSessionStore.subscribe(() => {
      const result = resolve();
      if (result !== undefined) complete(result);
    });
    const timeoutId = window.setTimeout(
      () => complete(null),
      WORKSPACE_SESSION_PROMOTION_TIMEOUT_MS,
    );
  });
}

async function waitForBackendSessionId(
  originalSessionId: string,
  recordId: string,
): Promise<string | null> {
  const resolve = (): string | null | undefined => {
    const session = useChatSessionStore
      .getState()
      .sessions.find(
        (candidate) =>
          candidate.id === originalSessionId ||
          candidate.clientSessionId === originalSessionId,
      );
    if (!session || session.archivedAt || session.creationState === "failed") {
      return null;
    }
    const resolvedSessionId = resolveDeferredSessionId(
      originalSessionId,
      recordId,
    );
    if (!resolvedSessionId) return null;
    return session.creationState === "pending" ||
      resolvedSessionId === originalSessionId
      ? undefined
      : resolvedSessionId;
  };

  const initial = resolve();
  if (initial !== undefined) return initial;
  return new Promise((finish) => {
    const unsubscribe = useChatSessionStore.subscribe(() => {
      const result = resolve();
      if (result === undefined) return;
      unsubscribe();
      finish(result);
    });
  });
}

function sessionSnapshot(sessionId: string, recordId?: string): string | null {
  const resolvedSessionId = resolveDeferredSessionId(sessionId, recordId);
  const session = resolvedSessionId
    ? useChatSessionStore.getState().getSession(resolvedSessionId)
    : null;
  if (!session) return null;
  return JSON.stringify({
    projectId: session.projectId ?? null,
    workingDir: session.workingDir ?? null,
    attachments: getWorkspaceAttachments(session)
      .filter((attachment) => attachment.source !== "excluded")
      .map(({ source, path, kind, branch }) => ({ source, path, kind, branch }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  });
}

function deferredRecord(
  sessionId: string,
  recordId?: string,
):
  | (QueuedMessageRecord & { kind: "deferred"; state: DeferredWorkspaceSend })
  | null {
  const records =
    useChatStore.getState().queuedMessageBySession[sessionId] ?? [];
  const record = recordId
    ? records.find((candidate) => candidate.recordId === recordId)
    : records[0];
  return record?.kind === "deferred" &&
    (!recordId || record.recordId === recordId) &&
    (record.state as DeferredWorkspaceSend).type === "workspace-first-send"
    ? (record as QueuedMessageRecord & {
        kind: "deferred";
        state: DeferredWorkspaceSend;
      })
    : null;
}

export function releaseDeferredWorkspaceSend(
  sessionId: string,
  recordId: string,
  sendAnyway = false,
): boolean {
  const resolvedSessionId = resolveDeferredSessionId(sessionId, recordId);
  if (!resolvedSessionId) return false;
  const record = deferredRecord(resolvedSessionId, recordId);
  const session = useChatSessionStore.getState().getSession(resolvedSessionId);
  if (
    !record ||
    !session?.executionTarget ||
    (!sendAnyway &&
      !workspaceAttachmentsEqualConfiguration(
        record.state.desired,
        session.workspaceAttachments,
      ))
  ) {
    return false;
  }
  return useChatStore
    .getState()
    .releaseDeferredMessage(resolvedSessionId, record.recordId);
}

export function hasDeferredWorkspaceSend(sessionId: string): boolean {
  return deferredRecord(sessionId) !== null;
}

export async function provisionPreSendProjectWorkspaces(
  sessionId: string,
  project: ProjectInfo,
  startupName: string,
): Promise<string> {
  let resolvedSessionId = resolveDeferredSessionId(sessionId);
  const session = resolvedSessionId
    ? useChatSessionStore.getState().getSession(resolvedSessionId)
    : null;
  if (!resolvedSessionId || !session || session.archivedAt) {
    throw new Error("The chat is no longer available for workspace setup.");
  }

  let originalWorkspaceState = {
    workingDir: session.workingDir,
    workspaceAttachments: session.workspaceAttachments,
    activeWorkspaceId: session.activeWorkspaceId,
  };
  let originalWorkspaceSnapshot = sessionSnapshot(sessionId);
  let switchedTarget: SessionExecutionTarget | undefined;
  const plan = await planProjectChatWorkspaces(project, startupName);
  if (!plan) {
    throw new Error("The project has no folders to configure.");
  }

  try {
    const liveProject = useProjectStore
      .getState()
      .projects.find((candidate) => candidate.id === project.id);
    if (
      !liveProject ||
      !projectWorkspaceConfigurationsEqual(
        liveProject.projectWorkspaces,
        project.projectWorkspaces,
      )
    ) {
      throw new Error("The project folders changed during workspace setup.");
    }

    if (session.creationState === "pending") {
      const promotedSessionId = await waitForPromotedSessionId(sessionId);
      if (!promotedSessionId) {
        throw new Error("Chat creation failed during workspace setup.");
      }
      resolvedSessionId = promotedSessionId;
      const promotedSession = useChatSessionStore
        .getState()
        .getSession(resolvedSessionId);
      if (!promotedSession) {
        throw new Error("Chat creation failed during workspace setup.");
      }
      originalWorkspaceState = {
        workingDir: promotedSession.workingDir,
        workspaceAttachments: promotedSession.workspaceAttachments,
        activeWorkspaceId: promotedSession.activeWorkspaceId,
      };
      originalWorkspaceSnapshot = sessionSnapshot(resolvedSessionId);
    }

    const currentProject = useProjectStore
      .getState()
      .projects.find((candidate) => candidate.id === project.id);
    const currentSessionSnapshot = sessionSnapshot(resolvedSessionId);
    if (
      !currentProject ||
      !projectWorkspaceConfigurationsEqual(
        currentProject.projectWorkspaces,
        project.projectWorkspaces,
      ) ||
      currentSessionSnapshot !== originalWorkspaceSnapshot
    ) {
      throw new Error("The project workspace changed during setup. Try again.");
    }

    const preparedSession = useChatSessionStore
      .getState()
      .getSession(resolvedSessionId);
    if (!preparedSession?.executionTarget) {
      throw new Error("Select a model before configuring this workspace.");
    }
    const prepared = await transitionSessionTarget({
      sessionId: resolvedSessionId,
      target: preparedSession.executionTarget,
      workingDir: plan.workingDir,
    });
    if (!prepared.applied) {
      throw new Error("The chat could not switch to the new worktree.");
    }
    switchedTarget = preparedSession.executionTarget;
    const finalProject = useProjectStore
      .getState()
      .projects.find((candidate) => candidate.id === project.id);
    if (
      !finalProject ||
      !projectWorkspaceConfigurationsEqual(
        finalProject.projectWorkspaces,
        project.projectWorkspaces,
      ) ||
      sessionSnapshot(resolvedSessionId) !== originalWorkspaceSnapshot
    ) {
      throw new Error("The project workspace changed during setup. Try again.");
    }
    useChatSessionStore.getState().patchSession(resolvedSessionId, {
      workingDir: plan.workingDir,
      workspaceAttachments: plan.workspaceAttachments,
      activeWorkspaceId: plan.workspaceAttachments[0]?.id,
      ...(prepared.configOptionsSnapshot?.reasoningEffort
        ? { reasoningEffort: prepared.configOptionsSnapshot.reasoningEffort }
        : {}),
    });
    return resolvedSessionId;
  } catch (error) {
    let rollbackError: unknown;
    if (switchedTarget && !originalWorkspaceState.workingDir) {
      rollbackError = new Error(
        "Berd couldn’t safely return the chat to its original folder.",
      );
    } else if (switchedTarget && originalWorkspaceState.workingDir) {
      const restored = await transitionSessionTarget({
        sessionId: resolvedSessionId,
        target: switchedTarget,
        workingDir: originalWorkspaceState.workingDir,
      });
      if (!restored.applied) {
        rollbackError = new Error(
          "Berd couldn’t safely return the chat to its original folder.",
        );
      }
    }
    if (!rollbackError) {
      await rollbackProjectChatWorkspacePlan(plan);
      const rollbackSession = useChatSessionStore
        .getState()
        .getSession(resolvedSessionId);
      if (rollbackSession) {
        useChatSessionStore
          .getState()
          .patchSession(resolvedSessionId, originalWorkspaceState);
      }
    }
    throw rollbackError ?? error;
  }
}

/** Call only after an explicit successful user workspace/configuration edit. */
export function releaseWorkspaceSendAfterUserEdit(sessionId: string): boolean {
  const record = deferredRecord(sessionId);
  const attachments = useChatSessionStore
    .getState()
    .getSession(sessionId)?.workspaceAttachments;
  if (
    record?.state.desired.some(
      (workspace) =>
        workspace.startupMode !== "none" &&
        attachments?.some(
          (attachment) =>
            attachment.source === "selected" &&
            isSameWorkspacePath(attachment.path, workspace.path),
        ),
    )
  ) {
    return false;
  }
  return record
    ? releaseDeferredWorkspaceSend(sessionId, record.recordId)
    : false;
}

export async function createDeferredWorkspaces(
  sessionId: string,
  recordId: string,
  name: string | null,
): Promise<void> {
  let resolvedSessionId = resolveDeferredSessionId(sessionId, recordId);
  if (!resolvedSessionId) return;
  let record = deferredRecord(resolvedSessionId, recordId);
  const session = useChatSessionStore.getState().getSession(resolvedSessionId);
  const originalWorkspaceState = session
    ? {
        workingDir: session.workingDir,
        workspaceAttachments: session.workspaceAttachments,
      }
    : null;
  const project = useProjectStore
    .getState()
    .projects.find((candidate) => candidate.id === record?.state.projectId);
  if (!record || !session) return;
  if (session.creationState === "failed") {
    useChatStore.getState().updateDeferredMessage(resolvedSessionId, recordId, {
      ...record.state,
      status: "failed",
      error: session.creationError ?? "The chat could not be created.",
    });
    return;
  }
  const expectedConfigurationRevision =
    record.state.configurationRevision ??
    projectWorkspaceConfigurationRevision(record.state.desired);
  if (
    !project ||
    projectWorkspaceConfigurationRevision(project.projectWorkspaces) !==
      expectedConfigurationRevision
  ) {
    useChatStore.getState().updateDeferredMessage(resolvedSessionId, recordId, {
      ...record.state,
      status: "failed",
      error: "The project workspace configuration changed before setup began.",
    });
    return;
  }

  useChatStore.getState().updateDeferredMessage(resolvedSessionId, recordId, {
    ...record.state,
    status: "creating",
    error: undefined,
  });
  const snapshot = sessionSnapshot(sessionId, recordId);
  try {
    const plan = name
      ? await planProjectChatWorkspaces(project, name)
      : planProjectChatWorkspacesAsIs(project);
    resolvedSessionId = resolveDeferredSessionId(sessionId, recordId);
    record = resolvedSessionId
      ? deferredRecord(resolvedSessionId, recordId)
      : null;
    if (!resolvedSessionId || !record) {
      await rollbackProjectChatWorkspacePlan(plan);
      return;
    }
    const desiredProjectId = record.state.projectId;
    const liveProject = useProjectStore
      .getState()
      .projects.find((candidate) => candidate.id === desiredProjectId);
    if (
      !liveProject ||
      projectWorkspaceConfigurationRevision(liveProject.projectWorkspaces) !==
        expectedConfigurationRevision
    ) {
      await rollbackProjectChatWorkspacePlan(plan);
      useChatStore
        .getState()
        .updateDeferredMessage(resolvedSessionId, recordId, {
          ...record.state,
          status: "held",
        });
      return;
    }
    if (sessionSnapshot(sessionId, recordId) !== snapshot) {
      await rollbackProjectChatWorkspacePlan(plan);
      useChatStore
        .getState()
        .updateDeferredMessage(resolvedSessionId, recordId, {
          ...record.state,
          status: "held",
        });
      return;
    }
    const current = useChatSessionStore
      .getState()
      .getSession(resolvedSessionId);
    const workingDir = plan?.workingDir ?? current?.workingDir;
    if (!current || current.archivedAt || !workingDir) {
      await rollbackProjectChatWorkspacePlan(plan);
      if (current?.archivedAt && resolvedSessionId && record) {
        useChatStore
          .getState()
          .updateDeferredMessage(resolvedSessionId, recordId, {
            ...record.state,
            status: "held",
          });
      }
      return;
    }
    if (current.creationState === "pending") {
      const backendSessionId = await waitForBackendSessionId(
        sessionId,
        recordId,
      );
      if (!backendSessionId) {
        let error = "Chat creation failed before workspace setup completed.";
        try {
          await rollbackProjectChatWorkspacePlan(plan);
          if (originalWorkspaceState) {
            const rollbackSessionId =
              resolveDeferredSessionId(sessionId, recordId) ??
              resolvedSessionId;
            useChatSessionStore
              .getState()
              .patchSession(rollbackSessionId, originalWorkspaceState);
          }
        } catch (rollbackError) {
          error += ` ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
        }
        const failedSessionId = resolveDeferredSessionId(sessionId, recordId);
        if (failedSessionId) {
          const failedRecord = deferredRecord(failedSessionId, recordId);
          if (failedRecord) {
            useChatStore
              .getState()
              .updateDeferredMessage(failedSessionId, recordId, {
                ...failedRecord.state,
                status: "failed",
                error,
              });
          }
        }
        return;
      }
      resolvedSessionId = backendSessionId;
    }
    const appliedSnapshot = sessionSnapshot(sessionId, recordId);
    const preparedSession = useChatSessionStore
      .getState()
      .getSession(resolvedSessionId);
    if (!preparedSession) return;
    if (!preparedSession.executionTarget) {
      useChatStore
        .getState()
        .updateDeferredMessage(resolvedSessionId, recordId, {
          ...record.state,
          status: "held",
          error: UNRESOLVED_DEFERRED_SEND_ERROR,
        });
      return;
    }
    const prepared = await transitionSessionTarget({
      sessionId: resolvedSessionId,
      target: preparedSession.executionTarget,
      workingDir,
    });
    resolvedSessionId = resolveDeferredSessionId(sessionId, recordId);
    record = resolvedSessionId
      ? deferredRecord(resolvedSessionId, recordId)
      : null;
    if (!resolvedSessionId || !record) return;
    if (
      !prepared.applied ||
      sessionSnapshot(sessionId, recordId) !== appliedSnapshot
    ) {
      if (prepared.applied) {
        const concurrentWorkspaceState = useChatSessionStore
          .getState()
          .getSession(resolvedSessionId);
        const restored = concurrentWorkspaceState?.workingDir
          ? await transitionSessionTarget({
              sessionId: resolvedSessionId,
              target: preparedSession.executionTarget,
              workingDir: concurrentWorkspaceState.workingDir,
            })
          : null;
        if (!restored?.applied) {
          useChatStore
            .getState()
            .updateDeferredMessage(resolvedSessionId, recordId, {
              ...record.state,
              status: "failed",
              error:
                "Berd couldn’t safely return the chat to its original folder.",
            });
          return;
        }
      }
      await rollbackProjectChatWorkspacePlan(plan);
      useChatStore
        .getState()
        .updateDeferredMessage(resolvedSessionId, recordId, {
          ...record.state,
          status: "held",
        });
      return;
    }
    const finalProjectId = record.state.projectId;
    const finalProject = useProjectStore
      .getState()
      .projects.find((candidate) => candidate.id === finalProjectId);
    if (
      !finalProject ||
      projectWorkspaceConfigurationRevision(finalProject.projectWorkspaces) !==
        expectedConfigurationRevision
    ) {
      const restored = originalWorkspaceState?.workingDir
        ? await transitionSessionTarget({
            sessionId: resolvedSessionId,
            target: preparedSession.executionTarget,
            workingDir: originalWorkspaceState.workingDir,
          })
        : null;
      if (!restored?.applied) {
        useChatStore
          .getState()
          .updateDeferredMessage(resolvedSessionId, recordId, {
            ...record.state,
            status: "failed",
            error:
              "Berd couldn’t safely return the chat to its original folder.",
          });
        return;
      }
      await rollbackProjectChatWorkspacePlan(plan);
      if (originalWorkspaceState) {
        useChatSessionStore
          .getState()
          .patchSession(resolvedSessionId, originalWorkspaceState);
      }
      useChatStore
        .getState()
        .updateDeferredMessage(resolvedSessionId, recordId, {
          ...record.state,
          status: "held",
        });
      return;
    }
    const releaseSession = useChatSessionStore
      .getState()
      .getSession(resolvedSessionId);
    if (!releaseSession || releaseSession.archivedAt) {
      useChatStore
        .getState()
        .updateDeferredMessage(resolvedSessionId, recordId, {
          ...record.state,
          status: "held",
        });
      return;
    }
    useChatSessionStore.getState().patchSession(resolvedSessionId, {
      workingDir,
      workspaceAttachments: plan?.workspaceAttachments,
      activeWorkspaceId: plan?.workspaceAttachments[0]?.id,
      ...(prepared.configOptionsSnapshot?.reasoningEffort
        ? { reasoningEffort: prepared.configOptionsSnapshot.reasoningEffort }
        : {}),
    });
    if (name === null) {
      useChatStore
        .getState()
        .releaseDeferredMessage(resolvedSessionId, record.recordId);
    } else {
      releaseDeferredWorkspaceSend(sessionId, recordId);
    }
  } catch (error) {
    resolvedSessionId = resolveDeferredSessionId(sessionId, recordId);
    record = resolvedSessionId
      ? deferredRecord(resolvedSessionId, recordId)
      : null;
    if (!resolvedSessionId || !record) return;
    useChatStore.getState().updateDeferredMessage(resolvedSessionId, recordId, {
      ...record.state,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function cancelDeferredWorkspaceNaming(sessionId: string): boolean {
  const record = deferredRecord(sessionId);
  if (!record || record.state.status !== "naming") return false;
  useChatStore.getState().updateDeferredMessage(sessionId, record.recordId, {
    ...record.state,
    status: "choice",
  });
  return true;
}

export function chooseDeferredWorkspaceSetup(
  sessionId: string,
  create: boolean,
): boolean {
  const record = deferredRecord(sessionId);
  if (!record || record.state.status !== "choice") return false;
  if (!create) {
    void createDeferredWorkspaces(sessionId, record.recordId, null);
    return true;
  }
  useChatStore.getState().updateDeferredMessage(sessionId, record.recordId, {
    ...record.state,
    status: "naming",
  });
  return true;
}

function payloadForDeferredWorkspaceSetup(
  payload: QueuedMessagePayload,
): QueuedMessagePayload {
  if (!payload.sendOptions?.executionSystemPrompt) return payload;
  return {
    ...payload,
    sendOptions: {
      ...payload.sendOptions,
      // Workspace creation may replace cwd and attachments. Preserve the
      // separately captured persona instructions, but derive all mixed
      // execution context from the prepared workspace at send time.
      executionSystemPrompt: undefined,
    },
  };
}

export function prepareExistingFirstSend(
  sessionId: string,
  recordId: string,
  options: {
    project?: ProjectInfo | null;
    onNeedsName?: (request: WorkspaceNameRequest) => void;
    onChoice?: () => void;
  } = {},
): boolean {
  const chat = useChatStore.getState();
  const record = chat.queuedMessageBySession[sessionId]?.find(
    (candidate) => candidate.recordId === recordId,
  );
  if (record?.kind !== "transport-ready") {
    return false;
  }
  const session = useChatSessionStore.getState().getSession(sessionId);
  const project =
    options.project ??
    useProjectStore
      .getState()
      .projects.find((candidate) => candidate.id === session?.projectId);
  if (
    !session ||
    getWorkspaceRepository().mode !== "multi" ||
    !project?.projectWorkspaces.length ||
    workspaceAttachmentsEqualConfiguration(
      project.projectWorkspaces,
      session.workspaceAttachments,
    )
  ) {
    return true;
  }

  const needsName = projectRequiresStartupWorkspaceName(project);
  const usesWorktreeChoice = project.projectWorkspaces.some((workspace) =>
    isAskWorktreeStartupMode(workspace.startupMode),
  );
  const manuallyManaged = project.projectWorkspaces.every(
    (workspace) =>
      workspace.startupMode === "none" ||
      workspace.startupMode === "ask-worktree",
  );
  if (manuallyManaged) return true;
  if (needsName && !usesWorktreeChoice && !options.onNeedsName) return false;
  if (
    !chat.deferTransportReadyMessage(
      sessionId,
      recordId,
      {
        type: "workspace-first-send",
        status: usesWorktreeChoice
          ? "choice"
          : needsName
            ? "naming"
            : "creating",
        projectId: project.id,
        desired: project.projectWorkspaces,
        configurationRevision: projectWorkspaceConfigurationRevision(
          project.projectWorkspaces,
        ),
      },
      payloadForDeferredWorkspaceSetup(record.payload),
    )
  ) {
    return false;
  }

  if (usesWorktreeChoice) {
    options.onChoice?.();
  } else if (needsName) {
    options.onNeedsName?.({
      workspaces: project.projectWorkspaces,
      submit: (name) =>
        void createDeferredWorkspaces(sessionId, recordId, name),
      cancel: () => {
        const resolvedSessionId = resolveDeferredSessionId(sessionId, recordId);
        if (resolvedSessionId) {
          useChatStore
            .getState()
            .dismissQueuedMessage(resolvedSessionId, recordId);
        }
      },
    });
  } else if (!needsName) {
    void createDeferredWorkspaces(sessionId, recordId, null);
  }
  return true;
}

export function acceptFirstSend(
  sessionId: string,
  payload: QueuedMessagePayload,
  options: {
    startupName?: string | null;
    project?: ProjectInfo | null;
    queueReady?: boolean;
    cancelBuilderDraftPath?: string;
    onNeedsName?: (request: WorkspaceNameRequest) => void;
  } = {},
): {
  accepted: boolean;
  deferred: boolean;
  needsName: boolean;
  occupied?: boolean;
} {
  const chat = useChatStore.getState();
  if ((chat.queuedMessageBySession[sessionId]?.length ?? 0) > 0) {
    return {
      accepted: false,
      deferred: false,
      needsName: false,
      occupied: true,
    };
  }
  const session = useChatSessionStore.getState().getSession(sessionId);
  const hasConversation =
    (session?.messageCount ?? 0) > 0 ||
    (chat.messagesBySession[sessionId] ?? []).some(
      (message) => message.role !== "system",
    );
  const project =
    options.project ??
    useProjectStore
      .getState()
      .projects.find((candidate) => candidate.id === session?.projectId);
  if (
    !session ||
    hasConversation ||
    getWorkspaceRepository().mode !== "multi" ||
    !project?.projectWorkspaces.length ||
    workspaceAttachmentsEqualConfiguration(
      project.projectWorkspaces,
      session?.workspaceAttachments,
    )
  ) {
    return {
      accepted:
        options.queueReady && isAdmittedQueuedMessagePayload(payload)
          ? chat.enqueueTransportReadyMessage(sessionId, payload)
          : false,
      deferred: false,
      needsName: false,
    };
  }

  const needsName = projectRequiresStartupWorkspaceName(project);
  const usesWorktreeChoice = project.projectWorkspaces.some((workspace) =>
    isAskWorktreeStartupMode(workspace.startupMode),
  );
  const manuallyManaged = project.projectWorkspaces.every(
    (workspace) =>
      workspace.startupMode === "none" ||
      workspace.startupMode === "ask-worktree",
  );
  if (manuallyManaged) {
    return {
      accepted:
        options.queueReady && isAdmittedQueuedMessagePayload(payload)
          ? chat.enqueueTransportReadyMessage(sessionId, payload)
          : false,
      deferred: false,
      needsName: false,
    };
  }
  const startupName = options.startupName;
  if (needsName && startupName === undefined && !options.onNeedsName) {
    return {
      accepted: false,
      deferred: false,
      needsName: true,
    };
  }
  const record = chat.enqueueDeferredMessage(
    sessionId,
    payloadForDeferredWorkspaceSetup(payload),
    {
      type: "workspace-first-send",
      status:
        needsName && startupName === undefined
          ? usesWorktreeChoice
            ? "choice"
            : "naming"
          : "creating",
      projectId: project.id,
      desired: project.projectWorkspaces,
      configurationRevision: projectWorkspaceConfigurationRevision(
        project.projectWorkspaces,
      ),
      cancelBuilderDraftPath: options.cancelBuilderDraftPath,
    },
  );
  if (!record) {
    return {
      accepted: false,
      deferred: false,
      needsName: false,
      occupied: true,
    };
  }

  if (needsName && startupName === undefined && !usesWorktreeChoice) {
    options.onNeedsName?.({
      workspaces: project.projectWorkspaces,
      submit: (name) =>
        void createDeferredWorkspaces(sessionId, record.recordId, name),
      cancel: () => {
        const resolvedSessionId = resolveDeferredSessionId(
          sessionId,
          record.recordId,
        );
        if (resolvedSessionId) {
          useChatStore
            .getState()
            .dismissQueuedMessage(resolvedSessionId, record.recordId);
        }
      },
    });
  } else if (!(needsName && startupName === undefined)) {
    void createDeferredWorkspaces(
      sessionId,
      record.recordId,
      startupName ?? null,
    );
  }
  return { accepted: true, deferred: true, needsName: false };
}
