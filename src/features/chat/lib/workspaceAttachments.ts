import { expandHomePath, isHomeRelativePath } from "@/shared/lib/homePath";
import type {
  WorkspaceAttachment,
  WorkspaceAttachmentLifecycle,
  WorkspaceAttachmentKind,
  WorkspaceAttachmentSource,
} from "@/shared/types/chat";
import type { GitState, WorktreeInfo } from "@/shared/types/git";
import {
  getPathBasename,
  getRelativePath,
  isPathWithin,
  isSamePath,
  toComparablePath,
  toIdentityKey,
} from "@/shared/lib/pathIdentity";

interface WorkspaceSessionFields {
  workingDir?: string | null;
  workspaceAttachments?: WorkspaceAttachment[];
  activeWorkspaceId?: string | null;
  messageCount?: number;
}

interface EnsureWorkspaceAttachmentOptions {
  path: string | null | undefined;
  source: WorkspaceAttachmentSource;
  kind?: WorkspaceAttachmentKind;
  branch?: string | null;
  repositoryPath?: string | null;
  worktreePath?: string | null;
  lifecycle?: WorkspaceAttachmentLifecycle | null;
  usedByAgent?: boolean;
  makeActive?: boolean;
}

interface RemoveWorkspaceAttachmentOptions {
  attachmentId: string;
}

export interface ClassifiedWorkspaceAttachment {
  kind: WorkspaceAttachmentKind;
  branch: string | null;
  repositoryPath: string | null;
  worktreePath: string | null;
}

export interface WorkspaceCleanupTarget {
  cleanup: "branch" | "worktree";
  branch: string | null;
  baseBranch: string | null;
  repositoryPath: string | null;
  worktreePath: string | null;
  createdBranch: boolean;
}

const SOURCE_PRIORITY: Record<WorkspaceAttachmentSource, number> = {
  excluded: -1,
  inferred: 0,
  selected: 1,
  created: 2,
};

function preferWorkspaceSource(
  current: WorkspaceAttachmentSource,
  next: WorkspaceAttachmentSource,
): WorkspaceAttachmentSource {
  return SOURCE_PRIORITY[next] > SOURCE_PRIORITY[current] ? next : current;
}

export function normalizeWorkspacePath(
  path: string | null | undefined,
): string | null {
  const trimmed = path?.trim();
  return trimmed ? trimmed : null;
}

export function workspaceAttachmentIdForPath(path: string): string {
  return `path:${toIdentityKey(path)}`;
}

export function normalizeComparableWorkspacePath(path: string): string {
  return toIdentityKey(path);
}

export function isSameWorkspacePath(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return isSamePath(a, b);
}

/** Compare persisted workspace paths that may mix `~` and expanded spellings. */
export function isSameWorkspacePathWithHome(
  a: string | null | undefined,
  b: string | null | undefined,
  homeDir: string,
): boolean {
  if (isSameWorkspacePath(a, b)) return true;
  if (!a || !b || (!isHomeRelativePath(a) && !isHomeRelativePath(b))) {
    return false;
  }
  return isSameWorkspacePath(
    expandHomePath(a, homeDir),
    expandHomePath(b, homeDir),
  );
}

function normalizeLifecycleString(value: string | null | undefined) {
  return normalizeWorkspacePath(value);
}

export function normalizeWorkspaceAttachmentLifecycle(
  lifecycle: WorkspaceAttachmentLifecycle | null | undefined,
): WorkspaceAttachmentLifecycle | undefined {
  if (!lifecycle || lifecycle.owner !== "goose") {
    return undefined;
  }
  if (lifecycle.cleanup !== "branch" && lifecycle.cleanup !== "worktree") {
    return undefined;
  }

  const normalized: WorkspaceAttachmentLifecycle = {
    owner: "goose",
    cleanup: lifecycle.cleanup,
  };
  const branch = normalizeLifecycleString(lifecycle.branch);
  const baseBranch = normalizeLifecycleString(lifecycle.baseBranch);
  const repositoryPath = normalizeWorkspacePath(lifecycle.repositoryPath);
  const worktreePath = normalizeWorkspacePath(lifecycle.worktreePath);

  if (branch) normalized.branch = branch;
  if (baseBranch) normalized.baseBranch = baseBranch;
  if (repositoryPath) normalized.repositoryPath = repositoryPath;
  if (worktreePath) normalized.worktreePath = worktreePath;
  if (lifecycle.createdBranch === true) normalized.createdBranch = true;

  return normalized;
}

export function getWorkspaceCleanupTarget(
  attachment: WorkspaceAttachment,
): WorkspaceCleanupTarget | null {
  const lifecycle = normalizeWorkspaceAttachmentLifecycle(attachment.lifecycle);
  if (!lifecycle) {
    return null;
  }

  const branch = normalizeLifecycleString(
    lifecycle.branch ?? attachment.branch,
  );
  const repositoryPath =
    normalizeWorkspacePath(lifecycle.repositoryPath) ??
    normalizeWorkspacePath(attachment.repositoryPath);
  const worktreePath =
    normalizeWorkspacePath(lifecycle.worktreePath) ??
    normalizeWorkspacePath(attachment.worktreePath);

  if (lifecycle.cleanup === "branch" && !branch) {
    return null;
  }
  if (lifecycle.cleanup === "worktree" && !worktreePath) {
    return null;
  }

  return {
    cleanup: lifecycle.cleanup,
    branch,
    baseBranch: normalizeLifecycleString(lifecycle.baseBranch),
    repositoryPath,
    worktreePath,
    createdBranch: lifecycle.createdBranch === true,
  };
}

function expandCleanupComparablePath(
  path: string | null | undefined,
  homeDir: string | null,
): string | null {
  if (!path) return null;
  if (!homeDir) return path;
  return expandHomePath(path, homeDir);
}

/**
 * Whether removing `target` would pull a branch/worktree out from under
 * `attachment`. Guards destructive cleanup, so both sides are compared in the
 * home-expanded spelling when `homeDir` is known: attachments can carry raw
 * `~` paths while cleanup targets store absolute ones (and vice versa for
 * lifecycles persisted before targets were classified via the expanded path),
 * and the comparison normalizer does not expand `~` on its own.
 */
export function workspaceAttachmentUsesCleanupTarget(
  attachment: WorkspaceAttachment,
  target: WorkspaceCleanupTarget,
  homeDir: string | null = null,
): boolean {
  const attachmentPath =
    expandCleanupComparablePath(attachment.path, homeDir) ?? attachment.path;
  const attachmentRepositoryPath = expandCleanupComparablePath(
    attachment.repositoryPath,
    homeDir,
  );
  const attachmentWorktreePath = expandCleanupComparablePath(
    attachment.worktreePath,
    homeDir,
  );
  const targetRepositoryPath = expandCleanupComparablePath(
    target.repositoryPath,
    homeDir,
  );
  const targetWorktreePath = expandCleanupComparablePath(
    target.worktreePath,
    homeDir,
  );

  if (target.cleanup === "worktree") {
    if (!targetWorktreePath) return false;
    return (
      isSameWorkspacePath(attachmentWorktreePath, targetWorktreePath) ||
      isSameWorkspacePath(attachmentPath, targetWorktreePath) ||
      getRelativeWorkspacePath(attachmentPath, targetWorktreePath) !== null
    );
  }

  const attachmentBranch = normalizeWorkspacePath(attachment.branch);
  const branchCouldMatch =
    Boolean(target.branch) &&
    (!attachmentBranch || attachmentBranch === target.branch);
  const matchesTargetCheckout =
    isSameWorkspacePath(attachmentRepositoryPath, targetRepositoryPath) ||
    isSameWorkspacePath(attachmentWorktreePath, targetWorktreePath) ||
    isSameWorkspacePath(attachmentPath, targetWorktreePath) ||
    getRelativeWorkspacePath(attachmentPath, targetWorktreePath) !== null ||
    isSameWorkspacePath(attachmentPath, targetRepositoryPath) ||
    getRelativeWorkspacePath(attachmentPath, targetRepositoryPath) !== null;

  return Boolean(branchCouldMatch && matchesTargetCheckout);
}

function isGitWorkspaceKind(kind: WorkspaceAttachmentKind): boolean {
  return (
    kind === "git-main-worktree" ||
    kind === "git-linked-worktree" ||
    kind === "git-detached-checkout" ||
    kind === "repository"
  );
}

export function createWorkspaceAttachment({
  path,
  source,
  kind = "directory",
  branch = null,
  repositoryPath = null,
  worktreePath = null,
  lifecycle = null,
  usedByAgent = false,
}: {
  path: string;
  source: WorkspaceAttachmentSource;
  kind?: WorkspaceAttachmentKind;
  branch?: string | null;
  repositoryPath?: string | null;
  worktreePath?: string | null;
  lifecycle?: WorkspaceAttachmentLifecycle | null;
  usedByAgent?: boolean;
}): WorkspaceAttachment {
  const attachment: WorkspaceAttachment = {
    id: workspaceAttachmentIdForPath(path),
    path,
    kind,
    source,
    branch,
    usedByAgent,
  };

  if (repositoryPath) {
    attachment.repositoryPath = repositoryPath;
  }
  if (worktreePath) {
    attachment.worktreePath = worktreePath;
  }
  const normalizedLifecycle = normalizeWorkspaceAttachmentLifecycle(lifecycle);
  if (normalizedLifecycle) {
    attachment.lifecycle = normalizedLifecycle;
  }

  return attachment;
}

function addExcludedWorkspaceAttachment(
  attachments: WorkspaceAttachment[],
  path: string,
): WorkspaceAttachment[] {
  const normalizedPath = normalizeWorkspacePath(path);
  if (!normalizedPath) {
    return attachments;
  }

  const identityKey = toIdentityKey(normalizedPath);
  return [
    ...attachments.filter(
      (attachment) => toIdentityKey(attachment.path) !== identityKey,
    ),
    createWorkspaceAttachment({
      path: normalizedPath,
      source: "excluded",
      kind: "directory",
    }),
  ];
}

export function getWorkspaceDisplayName(path: string): string {
  return getPathBasename(path) || path;
}

function getPathSegments(path: string): string[] {
  return toComparablePath(path).split("/").filter(Boolean);
}

function isDisplayableWorkspacePath(
  path: string | null | undefined,
): path is string {
  const normalizedPath = normalizeWorkspacePath(path);
  if (!normalizedPath) return false;
  const segments = getPathSegments(normalizedPath);
  const lastSegment = segments[segments.length - 1];
  return Boolean(lastSegment && lastSegment !== "." && lastSegment !== "..");
}

export function getRelativeWorkspacePath(
  path: string,
  rootPath: string | null | undefined,
): string | null {
  return getRelativePath(path, rootPath);
}

function getMainWorktreePath(gitState: GitState): string | null {
  const mainWorktreePath = normalizeWorkspacePath(gitState.mainWorktreePath);
  if (isDisplayableWorkspacePath(mainWorktreePath)) {
    return mainWorktreePath;
  }
  const mainWorktree = gitState.worktrees.find((worktree) => worktree.isMain);
  if (isDisplayableWorkspacePath(mainWorktree?.path)) {
    return mainWorktree.path;
  }
  const firstWorktree = gitState.worktrees.find((worktree) =>
    isDisplayableWorkspacePath(worktree.path),
  );
  return firstWorktree?.path ?? null;
}

function isPathInsideWorkspace(path: string, workspacePath: string): boolean {
  return isPathWithin(workspacePath, path);
}

function findContainingWorktree(
  path: string,
  worktrees: WorktreeInfo[],
): WorktreeInfo | null {
  const matchingWorktrees = worktrees.filter((worktree) =>
    isPathInsideWorkspace(path, worktree.path),
  );
  matchingWorktrees.sort(
    (a, b) =>
      normalizeComparableWorkspacePath(b.path).length -
      normalizeComparableWorkspacePath(a.path).length,
  );
  return matchingWorktrees[0] ?? null;
}

export function classifyWorkspaceAttachment(
  path: string,
  gitState: GitState,
): ClassifiedWorkspaceAttachment {
  if (!gitState.isGitRepo) {
    return {
      kind: "non-git-directory",
      branch: null,
      repositoryPath: null,
      worktreePath: null,
    };
  }

  const containingWorktree = findContainingWorktree(path, gitState.worktrees);
  const repositoryPath = getMainWorktreePath(gitState);
  if (containingWorktree) {
    if (!isSameWorkspacePath(path, containingWorktree.path)) {
      return {
        kind: "subdirectory",
        branch: containingWorktree.branch,
        repositoryPath,
        worktreePath: containingWorktree.path,
      };
    }

    return {
      kind: containingWorktree.isMain
        ? "git-main-worktree"
        : "git-linked-worktree",
      branch: containingWorktree.branch,
      repositoryPath,
      worktreePath: containingWorktree.path,
    };
  }

  return {
    kind: gitState.isWorktree ? "git-linked-worktree" : "repository",
    branch: gitState.currentBranch,
    repositoryPath: repositoryPath ?? path,
    worktreePath: path,
  };
}

export function classifyWorkspaceAttachmentIfInGitState(
  path: string,
  gitState: GitState,
): ClassifiedWorkspaceAttachment | null {
  if (!gitState.isGitRepo) {
    return classifyWorkspaceAttachment(path, gitState);
  }

  const containingWorktree = findContainingWorktree(path, gitState.worktrees);
  const repositoryPath = getMainWorktreePath(gitState);
  if (
    !containingWorktree &&
    (!repositoryPath || !isPathInsideWorkspace(path, repositoryPath))
  ) {
    return null;
  }

  return classifyWorkspaceAttachment(path, gitState);
}

export function enrichWorkspaceAttachmentWithGitState(
  attachment: WorkspaceAttachment,
  gitState: GitState | undefined,
): WorkspaceAttachment {
  if (!gitState) return attachment;

  const classification = classifyWorkspaceAttachmentIfInGitState(
    attachment.path,
    gitState,
  );
  if (!classification) return attachment;

  const enrichedAttachment: WorkspaceAttachment = {
    ...attachment,
    kind: classification.kind,
    branch: classification.branch ?? attachment.branch,
  };
  if (classification.repositoryPath) {
    enrichedAttachment.repositoryPath = classification.repositoryPath;
  }
  if (classification.worktreePath) {
    enrichedAttachment.worktreePath = classification.worktreePath;
  }
  return enrichedAttachment;
}

export function getWorkspaceTitle(
  attachment: Pick<
    WorkspaceAttachment,
    "path" | "repositoryPath" | "worktreePath" | "kind"
  >,
  gitState?: GitState,
): string {
  const path = toComparablePath(attachment.path);
  if (attachment.kind === "non-git-directory") {
    return getWorkspaceDisplayName(path);
  }

  const containingWorktree = gitState
    ? findContainingWorktree(path, gitState.worktrees)
    : null;
  const worktreePath =
    (isDisplayableWorkspacePath(attachment.worktreePath)
      ? attachment.worktreePath
      : null) ??
    containingWorktree?.path ??
    null;
  const repositoryPath =
    (isDisplayableWorkspacePath(attachment.repositoryPath)
      ? attachment.repositoryPath
      : null) ?? (gitState ? getMainWorktreePath(gitState) : null);
  const titleRoot = worktreePath ?? repositoryPath;
  const repositoryName = repositoryPath
    ? getWorkspaceDisplayName(repositoryPath)
    : titleRoot
      ? getWorkspaceDisplayName(titleRoot)
      : getWorkspaceDisplayName(path);
  const relativePath = getRelativeWorkspacePath(path, titleRoot);

  if (relativePath === "") {
    return repositoryName;
  }

  if (relativePath !== null) {
    const segments = getPathSegments(relativePath);
    if (segments.length === 0) {
      return repositoryName;
    }
    if (segments.length === 1) {
      return `${repositoryName}/${segments[0]}`;
    }
    return `${repositoryName}/.../${segments[segments.length - 1]}`;
  }

  return getWorkspaceDisplayName(path);
}

export function describeWorkspaceAttachmentKind(
  kind: WorkspaceAttachmentKind,
): string {
  switch (kind) {
    case "git-main-worktree":
      return "main git worktree";
    case "git-linked-worktree":
      return "linked git worktree";
    case "git-detached-checkout":
      return "detached git checkout";
    case "non-git-directory":
      return "non-git directory";
    case "subdirectory":
      return "subdirectory";
    case "repository":
      return "repository";
    default:
      return "directory";
  }
}

function normalizeWorkspaceAttachment(
  attachment: WorkspaceAttachment,
): WorkspaceAttachment | null {
  const path = normalizeWorkspacePath(attachment.path);
  if (!path) {
    return null;
  }

  const normalizedAttachment: WorkspaceAttachment = {
    ...attachment,
    id: attachment.id || workspaceAttachmentIdForPath(path),
    path,
    kind: attachment.kind ?? "directory",
    source: attachment.source ?? "inferred",
    branch: attachment.branch ?? null,
    usedByAgent: attachment.usedByAgent ?? false,
  };
  const lifecycle = normalizeWorkspaceAttachmentLifecycle(attachment.lifecycle);

  if (attachment.repositoryPath) {
    normalizedAttachment.repositoryPath = attachment.repositoryPath;
  } else {
    delete normalizedAttachment.repositoryPath;
  }
  if (attachment.worktreePath) {
    normalizedAttachment.worktreePath = attachment.worktreePath;
  } else {
    delete normalizedAttachment.worktreePath;
  }
  if (lifecycle) {
    normalizedAttachment.lifecycle = lifecycle;
  } else {
    delete normalizedAttachment.lifecycle;
  }

  return normalizedAttachment;
}

export function getWorkspaceAttachments(
  session: WorkspaceSessionFields,
): WorkspaceAttachment[] {
  const hasExplicitWorkspaceAttachments = Array.isArray(
    session.workspaceAttachments,
  );
  const normalizedAttachments = (session.workspaceAttachments ?? [])
    .map(normalizeWorkspaceAttachment)
    .filter(
      (attachment): attachment is WorkspaceAttachment => attachment !== null,
    );

  if (hasExplicitWorkspaceAttachments) {
    const attachmentsByPath = new Map<string, WorkspaceAttachment>();
    const activePath = normalizedAttachments.find(
      (attachment) => attachment.id === session.activeWorkspaceId,
    )?.path;
    const activePathKey = activePath ? toIdentityKey(activePath) : null;
    for (const attachment of normalizedAttachments) {
      const comparablePath = toIdentityKey(attachment.path);
      const existing = attachmentsByPath.get(comparablePath);
      if (!existing) {
        attachmentsByPath.set(comparablePath, attachment);
        continue;
      }
      const repositoryPath =
        attachment.repositoryPath ?? existing.repositoryPath;
      const worktreePath = attachment.worktreePath ?? existing.worktreePath;
      const lifecycle = attachment.lifecycle ?? existing.lifecycle;
      const preserveActiveAttachment =
        comparablePath === activePathKey &&
        attachment.id === session.activeWorkspaceId;
      const primaryAttachment = preserveActiveAttachment
        ? attachment
        : existing;
      const mergedAttachment: WorkspaceAttachment = {
        ...primaryAttachment,
        source: preferWorkspaceSource(existing.source, attachment.source),
        branch: attachment.branch ?? existing.branch,
        usedByAgent: existing.usedByAgent || attachment.usedByAgent,
      };
      if (repositoryPath) {
        mergedAttachment.repositoryPath = repositoryPath;
      }
      if (worktreePath) {
        mergedAttachment.worktreePath = worktreePath;
      }
      if (lifecycle) {
        mergedAttachment.lifecycle = lifecycle;
      }
      attachmentsByPath.set(comparablePath, mergedAttachment);
    }
    return [...attachmentsByPath.values()];
  }

  const workingDir = normalizeWorkspacePath(session.workingDir);
  if (!workingDir) {
    return [];
  }

  return [
    createWorkspaceAttachment({
      path: workingDir,
      source: "inferred",
      usedByAgent: (session.messageCount ?? 0) > 0,
    }),
  ];
}

export function getIncludedWorkspaceAttachments(
  session: WorkspaceSessionFields | null | undefined,
): WorkspaceAttachment[] {
  const hasExplicitWorkspaceAttachments = Array.isArray(
    session?.workspaceAttachments,
  );
  return (session ? getWorkspaceAttachments(session) : []).filter(
    (attachment) =>
      attachment.source !== "excluded" &&
      (hasExplicitWorkspaceAttachments ||
        attachment.source !== "inferred" ||
        isGitWorkspaceKind(attachment.kind)),
  );
}

export function formatIncludedWorkspacesPrompt(
  session: WorkspaceSessionFields | null | undefined,
): string | undefined {
  const attachments = getIncludedWorkspaceAttachments(session);
  if (attachments.length === 0) return undefined;

  const escapeIncludedWorkspacesClosingTag = (value: string) =>
    value.replace(/<\/included-workspaces>/gi, "<\\/included-workspaces>");
  const workspaceLines = attachments.flatMap((attachment) => {
    const lines = [
      `- path: ${escapeIncludedWorkspacesClosingTag(attachment.path)}`,
      `  kind: ${describeWorkspaceAttachmentKind(attachment.kind)}`,
    ];
    if (attachment.branch) {
      lines.push(
        `  branch: ${escapeIncludedWorkspacesClosingTag(attachment.branch)}`,
      );
    }
    return lines;
  });

  return [
    "<included-workspaces>",
    ...workspaceLines,
    "</included-workspaces>",
    "",
    "All listed workspaces are available for this chat. Use absolute paths when targeting a specific workspace.",
  ].join("\n");
}

export function getActiveWorkspaceId(
  session: WorkspaceSessionFields,
): string | null {
  const attachments = getWorkspaceAttachments(session).filter(
    (attachment) => attachment.source !== "excluded",
  );
  const activeWorkspaceId = session.activeWorkspaceId ?? null;
  if (
    activeWorkspaceId &&
    attachments.some((attachment) => attachment.id === activeWorkspaceId)
  ) {
    return activeWorkspaceId;
  }

  return attachments.length === 1 ? attachments[0].id : null;
}

export function getActiveWorkspaceAttachment(
  session: WorkspaceSessionFields,
): WorkspaceAttachment | null {
  const attachments = getWorkspaceAttachments(session).filter(
    (attachment) => attachment.source !== "excluded",
  );
  const activeWorkspaceId = getActiveWorkspaceId({
    ...session,
    workspaceAttachments: attachments,
  });

  if (!activeWorkspaceId) {
    return null;
  }

  return (
    attachments.find((attachment) => attachment.id === activeWorkspaceId) ??
    null
  );
}

export function getActiveWorkspacePath(
  session: WorkspaceSessionFields | null | undefined,
  overridePath?: string | null,
): string | null {
  const normalizedOverridePath = normalizeWorkspacePath(overridePath);
  if (normalizedOverridePath) {
    return normalizedOverridePath;
  }
  if (!session) {
    return null;
  }

  return (
    getActiveWorkspaceAttachment(session)?.path ??
    normalizeWorkspacePath(session.workingDir)
  );
}

export function withWorkspaceBackfill<T extends WorkspaceSessionFields>(
  session: T,
): T {
  const workspaceAttachments = getWorkspaceAttachments(session);
  const activeWorkspaceId = getActiveWorkspaceId({
    ...session,
    workspaceAttachments,
  });

  return {
    ...session,
    workspaceAttachments,
    activeWorkspaceId,
  };
}

export function ensureWorkspaceAttachment<T extends WorkspaceSessionFields>(
  session: T,
  options: EnsureWorkspaceAttachmentOptions,
): T {
  const path = normalizeWorkspacePath(options.path);
  if (!path) {
    return withWorkspaceBackfill(session);
  }

  const normalizedAttachments = getWorkspaceAttachments(session);
  const attachments =
    !Array.isArray(session.workspaceAttachments) &&
    options.source !== "inferred"
      ? normalizedAttachments.filter(
          (attachment) =>
            attachment.source !== "inferred" || attachment.usedByAgent,
        )
      : normalizedAttachments;
  let ensuredAttachmentId = workspaceAttachmentIdForPath(path);
  let didUpdateExisting = false;
  const comparablePath = toIdentityKey(path);
  const nextAttachments = attachments.map((attachment) => {
    if (toIdentityKey(attachment.path) !== comparablePath) {
      return attachment;
    }

    didUpdateExisting = true;
    ensuredAttachmentId = attachment.id;
    const repositoryPath =
      options.repositoryPath !== undefined
        ? options.repositoryPath
        : attachment.repositoryPath;
    const worktreePath =
      options.worktreePath !== undefined
        ? options.worktreePath
        : attachment.worktreePath;
    const lifecycle =
      options.lifecycle !== undefined
        ? normalizeWorkspaceAttachmentLifecycle(options.lifecycle)
        : attachment.lifecycle;
    const updatedAttachment: WorkspaceAttachment = {
      ...attachment,
      kind: options.kind ?? attachment.kind,
      source: preferWorkspaceSource(attachment.source, options.source),
      branch: options.branch !== undefined ? options.branch : attachment.branch,
      usedByAgent: attachment.usedByAgent || options.usedByAgent === true,
    };
    if (repositoryPath) {
      updatedAttachment.repositoryPath = repositoryPath;
    } else {
      delete updatedAttachment.repositoryPath;
    }
    if (worktreePath) {
      updatedAttachment.worktreePath = worktreePath;
    } else {
      delete updatedAttachment.worktreePath;
    }
    if (lifecycle) {
      updatedAttachment.lifecycle = lifecycle;
    } else {
      delete updatedAttachment.lifecycle;
    }

    return updatedAttachment;
  });

  if (!didUpdateExisting) {
    nextAttachments.push(
      createWorkspaceAttachment({
        path,
        source: options.source,
        kind: options.kind,
        branch: options.branch,
        repositoryPath: options.repositoryPath,
        worktreePath: options.worktreePath,
        lifecycle: options.lifecycle,
        usedByAgent: options.usedByAgent,
      }),
    );
  }

  const activeWorkspaceId = options.makeActive
    ? ensuredAttachmentId
    : getActiveWorkspaceId({
        ...session,
        workspaceAttachments: nextAttachments,
      });

  return {
    ...session,
    workspaceAttachments: nextAttachments,
    activeWorkspaceId,
  };
}

export function removeWorkspaceAttachment<T extends WorkspaceSessionFields>(
  session: T,
  options: RemoveWorkspaceAttachmentOptions,
): T {
  const attachments = getWorkspaceAttachments(session);
  const removedAttachment = attachments.find(
    (attachment) => attachment.id === options.attachmentId,
  );
  const nextAttachments = attachments.filter(
    (attachment) => attachment.id !== options.attachmentId,
  );

  if (nextAttachments.length === attachments.length) {
    const pathFromAttachmentId = options.attachmentId.startsWith("path:")
      ? options.attachmentId.slice("path:".length)
      : null;
    const excludedPath = normalizeWorkspacePath(pathFromAttachmentId);
    if (!excludedPath) {
      return withWorkspaceBackfill(session);
    }

    const withExcludedAttachment = addExcludedWorkspaceAttachment(
      attachments,
      excludedPath,
    );
    return {
      ...session,
      workspaceAttachments: withExcludedAttachment,
      activeWorkspaceId: getActiveWorkspaceId({
        ...session,
        workspaceAttachments: withExcludedAttachment,
        activeWorkspaceId:
          session.activeWorkspaceId === options.attachmentId
            ? null
            : session.activeWorkspaceId,
      }),
    };
  }

  const shouldExcludeRemovedAttachment =
    removedAttachment &&
    (removedAttachment.source === "inferred" ||
      isSameWorkspacePath(removedAttachment.path, session.workingDir));
  const nextAttachmentsWithExclusion = shouldExcludeRemovedAttachment
    ? addExcludedWorkspaceAttachment(nextAttachments, removedAttachment.path)
    : nextAttachments;

  const activeWorkspaceId =
    session.activeWorkspaceId === options.attachmentId
      ? getActiveWorkspaceId({
          ...session,
          workspaceAttachments: nextAttachmentsWithExclusion,
          activeWorkspaceId: null,
        })
      : getActiveWorkspaceId({
          ...session,
          workspaceAttachments: nextAttachmentsWithExclusion,
        });

  return {
    ...session,
    workspaceAttachments: nextAttachmentsWithExclusion,
    activeWorkspaceId,
  };
}
