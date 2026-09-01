import type { WorkspaceAttachment } from "@/shared/types/chat";
import { getGitState } from "@/shared/api/git";
import { getHomeDir } from "@/shared/api/system";
import {
  canonicalizeAuthorizedWorkspaceDirectory,
  resolvePath,
} from "@/shared/api/pathResolver";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import {
  classifyWorkspaceAttachment,
  getWorkspaceAttachments,
  isSameWorkspacePathWithHome,
  workspaceAttachmentIdForPath,
} from "@/features/chat/lib/workspaceAttachments";
import { isRemoteSession } from "@/features/chat/lib/remoteSession";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { getMultiWorkspaceEnabled } from "@/features/workspaces/multiWorkspacePreference";
import {
  getOptimisticArtifactCwd,
  resolveArtifactRootPath,
} from "@/shared/artifacts/sessionArtifactLocation";
import {
  claimSessionWorkspaceIntent,
  getPendingSessionWorkspaceActivation,
  getSessionWorkspaceIntentGeneration,
  isCurrentSessionWorkspaceIntent,
  queueSessionWorkspaceActivation,
  supersedePendingSessionWorkspaceActivation,
} from "@/features/chat/lib/sessionWorkspaceActivation";

export class FolderAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FolderAttachmentError";
  }
}

/**
 * Folder attachment canonicalizes, git-probes, and existence-checks paths on
 * the LOCAL filesystem, but a remote session's workspace lives on its SSH
 * host — attaching local folders to it is meaningless in v1. Every mutation
 * entry point below rejects up front instead of persisting a mixed-machine
 * workspace set.
 */
function assertLocalSession(
  sessionId: string,
  operation: "attach" | "detach" | "replace",
): void {
  const session = useChatSessionStore.getState().getSession(sessionId);
  if (session && isRemoteSession(session)) {
    throw new FolderAttachmentError(
      `Cannot ${operation} folders for session "${sessionId}": it runs on remote host "${session.remoteHost}", and local folder attachments are not supported for remote sessions.`,
    );
  }
}

async function getAuthorizedWorkspaceRoots(
  sessionId: string,
): Promise<string[]> {
  const session = useChatSessionStore.getState().getSession(sessionId);
  if (!session) {
    throw new FolderAttachmentError(`No session "${sessionId}"`);
  }

  const projectStore = useProjectStore.getState();
  if (session.projectId && !projectStore.hasFetchedProjects) {
    await projectStore.fetchProjects();
  }
  const freshProjectStore = useProjectStore.getState();
  const projectRoots =
    session.projectId && freshProjectStore.hasFetchedProjects
      ? (freshProjectStore.projects.find(
          (project) => project.id === session.projectId,
        )?.workingDirs ?? [])
      : [];
  const attachmentRoots = (session.workspaceAttachments ?? [])
    .filter((attachment) => attachment.source !== "excluded")
    .map((attachment) => attachment.path);
  const baseAllowedRoots = [
    session.workingDir,
    ...attachmentRoots,
    ...projectRoots,
  ].filter((root): root is string => Boolean(root?.trim()));

  // Git may create a sibling worktree outside the lexical project root. Expand
  // authority only from Git's structured worktree registry for repositories
  // the chat already owns; an arbitrary cwd cannot grant itself authority.
  const knownRepositoryWorktrees = (
    await Promise.all(
      baseAllowedRoots.map(async (root) => {
        try {
          return (await getGitState(root)).worktrees.map(
            (worktree) => worktree.path,
          );
        } catch {
          return [];
        }
      }),
    )
  ).flat();
  return [...new Set([...baseAllowedRoots, ...knownRepositoryWorktrees])];
}

async function canonicalizeForSession(
  sessionId: string,
  requestedPath: string,
  operation: "attach" | "detach",
): Promise<string> {
  try {
    return (
      await canonicalizeAuthorizedWorkspaceDirectory({
        path: requestedPath,
        allowedRoots: await getAuthorizedWorkspaceRoots(sessionId),
      })
    ).path;
  } catch (error) {
    if (error instanceof FolderAttachmentError) throw error;
    throw new FolderAttachmentError(
      `Could not ${operation} "${requestedPath}": ${String(error)}`,
    );
  }
}

async function canonicalizeDetachablePath(
  sessionId: string,
  requestedPath: string,
  homeDir: string,
): Promise<string> {
  const session = useChatSessionStore.getState().getSession(sessionId);
  if (!session) {
    throw new FolderAttachmentError(`No session "${sessionId}"`);
  }
  let resolvedRequestedPath = requestedPath;
  try {
    resolvedRequestedPath = (await resolvePath({ parts: [requestedPath] }))
      .path;
  } catch {
    // Existing directory validation below will return the actionable error.
  }
  const stored = getWorkspaceAttachments(session).find(
    (candidate) =>
      candidate.source !== "excluded" &&
      isSameWorkspacePathWithHome(
        candidate.path,
        resolvedRequestedPath,
        homeDir,
      ),
  );
  return (
    stored?.path ?? canonicalizeForSession(sessionId, requestedPath, "detach")
  );
}

export interface AttachSessionFolderOptions {
  promoteDefaultCwd?: boolean;
  beforeMutation?: () => void;
  enforceWorkspaceLimit?: boolean;
  replaceExistingInSingleWorkspace?: boolean;
}

function isImplicitDefaultCwd(
  sessionId: string,
  artifactRoot: string,
  homeDir: string,
): boolean {
  const session = useChatSessionStore.getState().getSession(sessionId);
  if (!session?.workingDir) return true;
  return (
    isSameWorkspacePathWithHome(session.workingDir, artifactRoot, homeDir) ||
    isSameWorkspacePathWithHome(
      session.workingDir,
      getOptimisticArtifactCwd(),
      homeDir,
    )
  );
}

interface PreparedSessionFolder {
  path: string;
  classification: ReturnType<typeof classifyWorkspaceAttachment>;
}

async function prepareSessionFolder(
  sessionId: string,
  requestedPath: string,
): Promise<PreparedSessionFolder> {
  let path = await canonicalizeForSession(sessionId, requestedPath, "attach");
  let classification: ReturnType<typeof classifyWorkspaceAttachment>;
  try {
    classification = classifyWorkspaceAttachment(path, await getGitState(path));
  } catch (error) {
    throw new FolderAttachmentError(
      `Could not inspect "${path}" before attaching it: ${String(error)}`,
    );
  }
  path = await canonicalizeForSession(sessionId, path, "attach");
  return { path, classification };
}

export async function attachSessionFolder(
  sessionId: string,
  requestedPath: string,
  options: AttachSessionFolderOptions = {},
): Promise<WorkspaceAttachment> {
  assertLocalSession(sessionId, "attach");
  const observedIntentGeneration =
    getSessionWorkspaceIntentGeneration(sessionId);
  const homeDir = await getHomeDir();
  const prepared = await prepareSessionFolder(sessionId, requestedPath);
  const artifactRoot = await resolveArtifactRootPath();
  const { classification } = prepared;
  const path = await canonicalizeForSession(sessionId, prepared.path, "attach");
  const shouldPromoteDefaultCwd =
    options.promoteDefaultCwd !== false &&
    isImplicitDefaultCwd(sessionId, artifactRoot, homeDir);

  // Reauthorize after every preparation/promotion await so policy and
  // persistence use the same current session state at the mutation boundary.
  const currentStore = useChatSessionStore.getState();
  const currentSession = currentStore.getSession(sessionId);
  if (!currentSession) {
    throw new FolderAttachmentError(`No session "${sessionId}"`);
  }
  const currentAttachments = getWorkspaceAttachments(currentSession);
  const includedAttachments = currentAttachments.filter(
    (candidate) => candidate.source !== "excluded",
  );
  const alreadyAttached = includedAttachments.find((candidate) =>
    isSameWorkspacePathWithHome(candidate.path, path, homeDir),
  );
  const singleWorkspaceReplacement =
    options.replaceExistingInSingleWorkspace &&
    !getMultiWorkspaceEnabled() &&
    !alreadyAttached
      ? includedAttachments[0]
      : undefined;
  if (options.enforceWorkspaceLimit && !getMultiWorkspaceEnabled()) {
    const realAttachments = includedAttachments.filter(
      (candidate) =>
        !isSameWorkspacePathWithHome(
          candidate.path,
          currentSession.workingDir,
          homeDir,
        ) || !shouldPromoteDefaultCwd,
    );
    if (!alreadyAttached && realAttachments.length > 0) {
      throw new FolderAttachmentError(
        "Multi-workspace support is disabled and this chat already has a workspace. Enable it, or use `berdctl folder replace` / `berdctl folder set-cwd`.",
      );
    }
  }
  options.beforeMutation?.();
  if (singleWorkspaceReplacement) {
    currentStore.replaceWorkspaceAttachment(sessionId, {
      oldAttachmentId: singleWorkspaceReplacement.id,
      path,
      source: "inferred",
      usedByAgent: true,
      ...classification,
    });
  } else {
    currentStore.attachWorkspace(sessionId, {
      path: alreadyAttached?.path ?? path,
      source: "inferred",
      usedByAgent: true,
      ...classification,
    });
  }

  if (isImplicitDefaultCwd(sessionId, artifactRoot, homeDir)) {
    const promotedSession = currentStore.getSession(sessionId);
    const implicitAttachment = promotedSession
      ? getWorkspaceAttachments(promotedSession).find(
          (candidate) =>
            candidate.source !== "excluded" &&
            isSameWorkspacePathWithHome(
              candidate.path,
              promotedSession.workingDir,
              homeDir,
            ),
        )
      : undefined;
    if (
      promotedSession &&
      implicitAttachment &&
      !isSameWorkspacePathWithHome(implicitAttachment.path, path, homeDir)
    ) {
      currentStore.patchSession(sessionId, {
        workspaceAttachments: getWorkspaceAttachments(promotedSession).filter(
          (candidate) => candidate.id !== implicitAttachment.id,
        ),
        activeWorkspaceId:
          promotedSession.activeWorkspaceId === implicitAttachment.id
            ? null
            : promotedSession.activeWorkspaceId,
      });
    }
  }

  const attachment = currentStore
    .getSession(sessionId)
    ?.workspaceAttachments?.find(
      (candidate) =>
        candidate.source !== "excluded" &&
        isSameWorkspacePathWithHome(candidate.path, path, homeDir),
    );
  if (!attachment) {
    throw new FolderAttachmentError(
      `Session "${sessionId}" disappeared before "${path}" could be attached`,
    );
  }
  if (
    shouldPromoteDefaultCwd &&
    getSessionWorkspaceIntentGeneration(sessionId) ===
      observedIntentGeneration &&
    isImplicitDefaultCwd(sessionId, artifactRoot, homeDir)
  ) {
    const intentGeneration = claimSessionWorkspaceIntent(sessionId);
    queueSessionWorkspaceActivation({
      sessionId,
      path: attachment.path,
      branch: attachment.branch ?? null,
      intentGeneration,
    });
  }
  return attachment;
}

export interface DetachSessionFolderResult {
  path: string;
  detached: boolean;
  cwd: string | null;
  cwdStatus: "unchanged" | "pending";
}

export interface DetachSessionFolderOptions {
  updateCwd?: boolean;
  beforeMutation?: () => void;
}

export async function detachSessionFolder(
  sessionId: string,
  requestedPath: string,
  options: DetachSessionFolderOptions = {},
): Promise<DetachSessionFolderResult> {
  assertLocalSession(sessionId, "detach");
  const homeDir = await getHomeDir();
  const path = await canonicalizeDetachablePath(
    sessionId,
    requestedPath,
    homeDir,
  );

  const currentStore = useChatSessionStore.getState();
  const session = currentStore.getSession(sessionId);
  if (!session) {
    throw new FolderAttachmentError(`No session "${sessionId}"`);
  }

  const attachment = getWorkspaceAttachments(session).find(
    (candidate) =>
      candidate.source !== "excluded" &&
      isSameWorkspacePathWithHome(candidate.path, path, homeDir),
  );
  if (!attachment) {
    return {
      path,
      detached: false,
      cwd: session.workingDir ?? null,
      cwdStatus: "unchanged",
    };
  }

  options.beforeMutation?.();
  const pendingActivation = getPendingSessionWorkspaceActivation(sessionId);
  if (
    pendingActivation &&
    isSameWorkspacePathWithHome(
      pendingActivation.path,
      attachment.path,
      homeDir,
    )
  ) {
    await supersedePendingSessionWorkspaceActivation(sessionId);
  }
  const latestSession = currentStore.getSession(sessionId);
  if (!latestSession) {
    throw new FolderAttachmentError(`No session "${sessionId}"`);
  }
  const latestAttachment = getWorkspaceAttachments(latestSession).find(
    (candidate) =>
      candidate.source !== "excluded" && candidate.id === attachment.id,
  );
  if (!latestAttachment) {
    return {
      path,
      detached: false,
      cwd: latestSession.workingDir ?? null,
      cwdStatus: "unchanged",
    };
  }
  const detachingCwd =
    latestSession.workingDir != null &&
    isSameWorkspacePathWithHome(latestSession.workingDir, path, homeDir);
  const intentGeneration =
    detachingCwd && options.updateCwd !== false
      ? claimSessionWorkspaceIntent(sessionId)
      : null;
  currentStore.removeWorkspaceAttachment(
    sessionId,
    latestAttachment.id || workspaceAttachmentIdForPath(path),
  );
  if (!detachingCwd || options.updateCwd === false) {
    return {
      path,
      detached: true,
      cwd: session.workingDir ?? null,
      cwdStatus: "unchanged",
    };
  }

  const updated = currentStore.getSession(sessionId);
  const fallbackAttachment = updated
    ? getWorkspaceAttachments(updated).find(
        (candidate) => candidate.source !== "excluded",
      )
    : undefined;
  const fallbackPath =
    fallbackAttachment?.path ?? (await resolveArtifactRootPath());
  const finalSession = currentStore.getSession(sessionId);
  if (
    intentGeneration == null ||
    !isCurrentSessionWorkspaceIntent(sessionId, intentGeneration) ||
    finalSession?.workingDir == null ||
    !isSameWorkspacePathWithHome(finalSession.workingDir, path, homeDir)
  ) {
    return {
      path,
      detached: true,
      cwd: finalSession?.workingDir ?? null,
      cwdStatus: "unchanged",
    };
  }
  queueSessionWorkspaceActivation({
    sessionId,
    path: fallbackPath,
    branch: fallbackAttachment?.branch ?? null,
    intentGeneration,
  });
  return {
    path,
    detached: true,
    cwd: fallbackPath,
    cwdStatus: "pending",
  };
}

export interface ReplaceSessionFolderResult {
  oldPath: string;
  newPath: string;
  kind: WorkspaceAttachment["kind"];
  branch: string | null;
  cwd: string | null;
  cwdStatus: "unchanged" | "pending";
}

export interface ReplaceSessionFolderOptions {
  beforeMutation?: () => void;
}

export async function replaceSessionFolder(
  sessionId: string,
  oldRequestedPath: string,
  newRequestedPath: string,
  options: ReplaceSessionFolderOptions = {},
): Promise<ReplaceSessionFolderResult> {
  assertLocalSession(sessionId, "replace");
  const homeDir = await getHomeDir();
  const oldPath = await canonicalizeDetachablePath(
    sessionId,
    oldRequestedPath,
    homeDir,
  );
  const session = useChatSessionStore.getState().getSession(sessionId);
  const oldAttachment = session
    ? getWorkspaceAttachments(session).find(
        (candidate) =>
          candidate.source !== "excluded" &&
          isSameWorkspacePathWithHome(candidate.path, oldPath, homeDir),
      )
    : undefined;
  if (!oldAttachment) {
    throw new FolderAttachmentError(
      `Could not replace "${oldPath}": it is not attached to session "${sessionId}"`,
    );
  }

  const workspaceIntentBeforeValidation =
    getSessionWorkspaceIntentGeneration(sessionId);
  const pendingActivationBeforeValidation =
    getPendingSessionWorkspaceActivation(sessionId);
  const prepared = await prepareSessionFolder(sessionId, newRequestedPath);
  const attachment: WorkspaceAttachment = {
    id: workspaceAttachmentIdForPath(prepared.path),
    path: prepared.path,
    source: "inferred",
    usedByAgent: true,
    ...prepared.classification,
  };

  // Re-read after async validation so cwd ownership and attachment state are
  // decided together at the mutation boundary.
  const currentStore = useChatSessionStore.getState();
  const currentSession = currentStore.getSession(sessionId);
  const currentOldAttachment = currentSession
    ? getWorkspaceAttachments(currentSession).find(
        (candidate) =>
          candidate.source !== "excluded" && candidate.id === oldAttachment.id,
      )
    : undefined;
  if (!currentOldAttachment) {
    throw new FolderAttachmentError(
      `Could not replace "${oldPath}": it is no longer attached to session "${sessionId}"`,
    );
  }
  const currentPendingActivation =
    getPendingSessionWorkspaceActivation(sessionId);
  const workspaceIntentChanged =
    getSessionWorkspaceIntentGeneration(sessionId) !==
    workspaceIntentBeforeValidation;
  const newerPendingActivation =
    workspaceIntentChanged &&
    currentPendingActivation != null &&
    currentPendingActivation.requestId !==
      pendingActivationBeforeValidation?.requestId;
  const replacingPendingCwd =
    !newerPendingActivation &&
    currentPendingActivation != null &&
    isSameWorkspacePathWithHome(
      currentPendingActivation.path,
      oldPath,
      homeDir,
    );
  const replacingCwd =
    !newerPendingActivation &&
    (replacingPendingCwd ||
      (currentSession?.workingDir != null &&
        isSameWorkspacePathWithHome(
          currentSession.workingDir,
          oldPath,
          homeDir,
        )));
  const intentGeneration = replacingCwd
    ? claimSessionWorkspaceIntent(sessionId)
    : null;

  options.beforeMutation?.();
  if (replacingPendingCwd) {
    await supersedePendingSessionWorkspaceActivation(
      sessionId,
      intentGeneration ?? undefined,
    );
  }
  currentStore.replaceWorkspaceAttachment(sessionId, {
    oldAttachmentId: currentOldAttachment.id,
    path: attachment.path,
    source: attachment.source,
    kind: attachment.kind,
    branch: attachment.branch,
    repositoryPath: attachment.repositoryPath,
    worktreePath: attachment.worktreePath,
    lifecycle: attachment.lifecycle,
    usedByAgent: attachment.usedByAgent,
  });
  const latestWorkingDir = useChatSessionStore
    .getState()
    .getSession(sessionId)?.workingDir;
  const stillOwnsCwd =
    replacingPendingCwd ||
    (latestWorkingDir != null &&
      isSameWorkspacePathWithHome(latestWorkingDir, oldPath, homeDir));
  const shouldMoveCwd =
    intentGeneration != null &&
    isCurrentSessionWorkspaceIntent(sessionId, intentGeneration) &&
    replacingCwd &&
    !isSameWorkspacePathWithHome(oldPath, attachment.path, homeDir) &&
    stillOwnsCwd;
  if (shouldMoveCwd) {
    queueSessionWorkspaceActivation({
      sessionId,
      path: attachment.path,
      branch: attachment.branch ?? null,
      intentGeneration,
    });
  }
  return {
    oldPath,
    newPath: attachment.path,
    kind: attachment.kind,
    branch: attachment.branch ?? null,
    cwd: shouldMoveCwd ? attachment.path : (latestWorkingDir ?? null),
    cwdStatus: shouldMoveCwd ? "pending" : "unchanged",
  };
}
