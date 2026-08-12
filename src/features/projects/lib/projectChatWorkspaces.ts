import {
  createBranch,
  createWorktree,
  deleteBranch,
  getGitState,
  removeWorktree,
} from "@/shared/api/git";
import { pathExists } from "@/shared/api/system";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import type { CreatedWorktree, GitState } from "@/shared/types/git";
import {
  classifyWorkspaceAttachment,
  getWorkspaceCleanupTarget,
  getRelativeWorkspacePath,
  isSameWorkspacePath,
  normalizeComparableWorkspacePath,
  workspaceAttachmentIdForPath,
} from "@/features/chat/lib/workspaceAttachments";
import {
  isWorktreeStartupMode,
  requiresWorkspaceStartup,
  type ProjectInfo,
  type ProjectWorkspace,
  type ProjectWorkspaceStartupMode,
} from "@/features/projects/api/projects";

export interface ProjectWorkspaceStartupSummary {
  worktreeCount: number;
  branchCount: number;
  exact: boolean;
}

export function summarizeProjectWorkspaceStartup(
  workspaces: ProjectWorkspace[],
): ProjectWorkspaceStartupSummary {
  const worktreeRepositories = new Set<string>();
  const branchRepositories = new Set<string>();

  let exact = true;

  for (const workspace of workspaces) {
    if (!requiresWorkspaceStartup(workspace.startupMode)) continue;
    exact &&= Boolean(workspace.repositoryPath || workspace.worktreePath);
    const repositoryKey = normalizedKey(
      workspace.repositoryPath ?? workspace.worktreePath ?? workspace.path,
    );
    const repositories = isWorktreeStartupMode(workspace.startupMode)
      ? worktreeRepositories
      : branchRepositories;
    repositories.add(repositoryKey);
  }

  return {
    worktreeCount: worktreeRepositories.size,
    branchCount: branchRepositories.size,
    exact,
  };
}

export interface ProjectChatWorkspacePlan {
  workingDir: string;
  workspaceAttachments: WorkspaceAttachment[];
}

interface ProjectWorkspaceGitContext {
  gitState: GitState;
  operationPath: string;
}

interface StartupRollbackAction {
  description: string;
  run: () => Promise<void>;
}

function normalizedKey(path: string): string {
  return normalizeComparableWorkspacePath(path);
}

function cleanupKeyPart(path: string | null | undefined): string {
  return path ? normalizedKey(path) : "";
}

function workspaceCleanupTargetKey(
  target: NonNullable<ReturnType<typeof getWorkspaceCleanupTarget>>,
): string {
  return [
    target.cleanup,
    target.branch ?? "",
    cleanupKeyPart(target.repositoryPath),
    cleanupKeyPart(target.worktreePath),
  ].join("|");
}

function projectWorkspaceToAttachment(
  workspace: ProjectWorkspace,
  overrides: Partial<WorkspaceAttachment> = {},
): WorkspaceAttachment {
  return {
    id: workspaceAttachmentIdForPath(overrides.path ?? workspace.path),
    path: workspace.path,
    kind: workspace.kind,
    source: "inferred",
    branch: workspace.branch ?? null,
    repositoryPath: workspace.repositoryPath,
    worktreePath: workspace.worktreePath,
    usedByAgent: false,
    ...overrides,
  };
}

function defaultBaseBranch(gitState: GitState): string {
  return gitState.currentBranch ?? "HEAD";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function friendlyWorkspaceSetupError(error: unknown): Error {
  const message = errorMessage(error);
  if (
    /choose a different name/i.test(message) ||
    /requires a Git repository/i.test(message) ||
    /name is required/i.test(message)
  ) {
    return new Error(message);
  }
  if (/already exists/i.test(message) && /branch/i.test(message)) {
    return new Error(
      "That worktree name is already in use. Choose another name.",
    );
  }
  if (
    /not a valid branch name|invalid branch name|cannot lock ref/i.test(message)
  ) {
    return new Error(
      "That name can’t be used for a worktree. Use letters, numbers, hyphens, or underscores.",
    );
  }
  if (/not inside one|not a git repository/i.test(message)) {
    return new Error("Choose a project folder that contains a Git repository.");
  }
  if (/timed out/i.test(message)) {
    return new Error("Creating the worktree took too long. Try again.");
  }
  if (/permission denied|operation not permitted/i.test(message)) {
    return new Error(
      "Berd doesn’t have permission to create a worktree there.",
    );
  }
  if (
    /git\s+worktree\s+add/i.test(message) ||
    /failed to create worktree/i.test(message)
  ) {
    return new Error("Berd couldn’t create that worktree. Try another name.");
  }
  return new Error("Berd couldn’t prepare the project workspace. Try again.");
}

async function rollbackStartupMutations(
  actions: StartupRollbackAction[],
): Promise<string[]> {
  const errors: string[] = [];
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index];
    if (!action) continue;
    try {
      await action.run();
    } catch (error) {
      errors.push(`${action.description}: ${errorMessage(error)}`);
    }
  }
  return errors;
}

export async function rollbackProjectChatWorkspacePlan(
  plan: ProjectChatWorkspacePlan | null | undefined,
): Promise<void> {
  if (!plan) {
    return;
  }

  const seenTargets = new Set<string>();
  const targets = [...plan.workspaceAttachments]
    .reverse()
    .map((attachment) => ({
      attachment,
      target: getWorkspaceCleanupTarget(attachment),
    }))
    .filter(
      (
        entry,
      ): entry is {
        attachment: WorkspaceAttachment;
        target: NonNullable<ReturnType<typeof getWorkspaceCleanupTarget>>;
      } => entry.target !== null,
    )
    .filter(({ target }) => {
      const key = workspaceCleanupTargetKey(target);
      if (seenTargets.has(key)) {
        return false;
      }
      seenTargets.add(key);
      return true;
    });

  const errors: string[] = [];
  for (const { attachment, target } of targets) {
    const repositoryPath =
      target.repositoryPath ??
      attachment.repositoryPath ??
      attachment.worktreePath ??
      attachment.path;

    if (target.cleanup === "worktree") {
      const worktreePath =
        target.worktreePath ?? attachment.worktreePath ?? attachment.path;
      try {
        await removeWorktree(repositoryPath, worktreePath, false);
      } catch (error) {
        errors.push(`remove worktree ${worktreePath}: ${errorMessage(error)}`);
      }

      if (target.createdBranch && target.branch) {
        try {
          await deleteBranch(
            repositoryPath,
            target.branch,
            false,
            target.baseBranch ?? undefined,
          );
        } catch (error) {
          errors.push(`delete branch ${target.branch}: ${errorMessage(error)}`);
        }
      }
      continue;
    }

    if (target.branch) {
      const checkoutPath =
        target.worktreePath ??
        attachment.worktreePath ??
        target.repositoryPath ??
        attachment.path;
      try {
        await deleteBranch(
          checkoutPath,
          target.branch,
          false,
          target.baseBranch ?? undefined,
        );
      } catch (error) {
        errors.push(`delete branch ${target.branch}: ${errorMessage(error)}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Workspace startup rollback failed: ${errors.join("; ")}`);
  }
}

function gitOperationPathCandidates(
  workspace: ProjectWorkspace,
  gitState: GitState | null,
): string[] {
  const classification = gitState
    ? classifyWorkspaceAttachment(workspace.path, gitState)
    : null;
  const classifiedRepositoryPath =
    classification?.repositoryPath &&
    !isSameWorkspacePath(classification.repositoryPath, workspace.path)
      ? classification.repositoryPath
      : null;
  const classifiedWorktreePath =
    classification?.worktreePath &&
    !isSameWorkspacePath(classification.worktreePath, workspace.path)
      ? classification.worktreePath
      : null;
  const repositoryCandidates = [
    gitState?.mainWorktreePath,
    classifiedRepositoryPath,
    workspace.repositoryPath,
  ];
  const worktreeCandidates = [classifiedWorktreePath, workspace.worktreePath];
  const candidates =
    workspace.startupMode === "branch" ||
    isWorktreeStartupMode(workspace.startupMode)
      ? [...worktreeCandidates, workspace.path, ...repositoryCandidates]
      : [...repositoryCandidates, ...worktreeCandidates, workspace.path];
  return candidates.filter((path): path is string => Boolean(path));
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const path of paths) {
    const key = normalizedKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(path);
  }
  return deduped;
}

function repositoryPathForGitContext(
  context: ProjectWorkspaceGitContext,
): string {
  return context.gitState.mainWorktreePath ?? context.operationPath;
}

function repositoryKeyForGitContext(
  context: ProjectWorkspaceGitContext,
): string {
  return normalizedKey(repositoryPathForGitContext(context));
}

function includedPathForCreatedWorktree(
  workspace: ProjectWorkspace,
  context: ProjectWorkspaceGitContext,
  worktree: CreatedWorktree,
): string {
  const { gitState } = context;
  const classification = classifyWorkspaceAttachment(workspace.path, gitState);
  const relativePath = getRelativeWorkspacePath(
    workspace.path,
    workspace.worktreePath ??
      classification.worktreePath ??
      context.operationPath,
  );
  if (!relativePath) {
    return worktree.path;
  }
  return `${worktree.path.replace(/\/+$/, "")}/${relativePath}`;
}

function attachmentForCreatedWorktree(
  workspace: ProjectWorkspace,
  context: ProjectWorkspaceGitContext,
  worktree: CreatedWorktree,
  baseBranch: string,
): WorkspaceAttachment {
  const { gitState } = context;
  const repositoryPath = repositoryPathForGitContext(context);
  const path = includedPathForCreatedWorktree(workspace, context, worktree);
  const classification = classifyWorkspaceAttachment(path, {
    ...gitState,
    isWorktree: true,
    currentBranch: worktree.branch,
    worktrees: [
      ...gitState.worktrees.filter(
        (existing) => !isSameWorkspacePath(existing.path, worktree.path),
      ),
      {
        path: worktree.path,
        branch: worktree.branch,
        isMain: false,
      },
    ],
  });

  return projectWorkspaceToAttachment(workspace, {
    id: workspaceAttachmentIdForPath(path),
    path,
    kind: classification.kind,
    source: "created",
    branch: classification.branch ?? worktree.branch,
    repositoryPath,
    worktreePath: classification.worktreePath ?? worktree.path,
    lifecycle: {
      owner: "goose",
      cleanup: "worktree",
      branch: worktree.branch,
      baseBranch,
      repositoryPath,
      worktreePath: worktree.path,
      createdBranch: true,
    },
  });
}

function attachmentForCreatedBranch(
  workspace: ProjectWorkspace,
  context: ProjectWorkspaceGitContext,
  branchName: string,
  baseBranch: string,
): WorkspaceAttachment {
  const { gitState } = context;
  const repositoryPath = repositoryPathForGitContext(context);
  const classification = classifyWorkspaceAttachment(workspace.path, {
    ...gitState,
    currentBranch: branchName,
    worktrees: gitState.worktrees.map((worktree) =>
      isSameWorkspacePath(
        worktree.path,
        workspace.worktreePath ?? workspace.path,
      )
        ? { ...worktree, branch: branchName }
        : worktree,
    ),
  });

  return projectWorkspaceToAttachment(workspace, {
    source: "created",
    branch: branchName,
    kind: classification.kind,
    repositoryPath,
    worktreePath:
      classification.worktreePath ??
      workspace.worktreePath ??
      context.operationPath,
    lifecycle: {
      owner: "goose",
      cleanup: "branch",
      branch: branchName,
      baseBranch,
      repositoryPath,
      worktreePath:
        classification.worktreePath ??
        workspace.worktreePath ??
        context.operationPath,
      createdBranch: true,
    },
  });
}

export function projectRequiresStartupWorkspaceName(
  project: Pick<ProjectInfo, "projectWorkspaces">,
): boolean {
  return (project.projectWorkspaces ?? []).some((workspace) =>
    requiresWorkspaceStartup(workspace.startupMode),
  );
}

export function planProjectChatWorkspacesAsIs(
  project: Pick<ProjectInfo, "projectWorkspaces" | "workingDirs">,
): ProjectChatWorkspacePlan | null {
  const attachments = project.projectWorkspaces.map((workspace) =>
    projectWorkspaceToAttachment(workspace),
  );
  if (attachments.length === 0) {
    return null;
  }

  return {
    workingDir: attachments[0]?.path ?? project.workingDirs[0],
    workspaceAttachments: attachments,
  };
}

function validateStartupName(
  workspaces: ProjectWorkspace[],
  startupName: string,
): void {
  if (workspaces.length === 0) {
    return;
  }

  if (!startupName) {
    throw new Error("A branch or worktree name is required.");
  }

  if (
    workspaces.some((workspace) => isWorktreeStartupMode(workspace.startupMode))
  ) {
    if (startupName === "." || startupName === "..") {
      throw new Error(
        "Worktree startup names must be real folder names. Choose a different name.",
      );
    }
    if (/[/\\]/.test(startupName)) {
      throw new Error(
        'Worktree startup names cannot include "/" or "\\". Choose a name without path separators.',
      );
    }
  }
}

function nonGitStartupWorkspaceError(workspace: ProjectWorkspace): Error {
  return new Error(
    `Project workspace startup requires a Git repository, but ${workspace.path} is not inside one.`,
  );
}

function existingStartupBranchError(
  workspace: ProjectWorkspace,
  branchName: string,
): Error {
  return new Error(
    `A branch named "${branchName}" already exists for ${workspace.path}. Choose a different name.`,
  );
}

function existingStartupWorktreePathError(
  workspace: ProjectWorkspace,
  worktreePath: string,
): Error {
  return new Error(
    `A worktree already exists at ${worktreePath} for ${workspace.path}. Choose a different name.`,
  );
}

function pathBasename(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

function pathDirname(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0) {
    return null;
  }
  if (index === 0) {
    return trimmed.slice(0, 1);
  }
  return trimmed.slice(0, index);
}

function joinDerivedPath(parent: string, ...segments: string[]): string {
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  let path = parent.replace(/[\\/]+$/, "") || separator;
  for (const segment of segments.filter(Boolean)) {
    path = path.endsWith(separator)
      ? `${path}${segment}`
      : `${path}${separator}${segment}`;
  }
  return path;
}

function deriveStartupWorktreePath(
  context: ProjectWorkspaceGitContext,
  worktreeName: string,
): string | null {
  const mainWorktreePath =
    context.gitState.mainWorktreePath ?? context.operationPath;
  const repoName = pathBasename(mainWorktreePath);
  const repoParent = pathDirname(mainWorktreePath);
  if (!repoName || !repoParent) {
    return null;
  }
  return joinDerivedPath(repoParent, `${repoName}-worktrees`, worktreeName);
}

export async function planProjectChatWorkspaces(
  project: Pick<ProjectInfo, "projectWorkspaces" | "workingDirs">,
  startupName?: string,
): Promise<ProjectChatWorkspacePlan | null> {
  const workspaces = project.projectWorkspaces;
  if (workspaces.length === 0) {
    return null;
  }

  const gitStateByPath = new Map<string, GitState>();
  const createdWorktreeByRepo = new Map<string, CreatedWorktree>();
  const createdBranchByRepo = new Set<string>();
  const rollbackActions: StartupRollbackAction[] = [];
  const attachments: WorkspaceAttachment[] = [];
  const trimmedStartupName = startupName?.trim() ?? "";
  const startupWorkspaces = workspaces.filter((workspace) =>
    requiresWorkspaceStartup(workspace.startupMode),
  );
  const gitStateForPath = async (path: string): Promise<GitState> => {
    const pathKey = normalizedKey(path);
    let gitState = gitStateByPath.get(pathKey);
    if (!gitState) {
      gitState = await getGitState(path);
      gitStateByPath.set(pathKey, gitState);
    }
    return gitState;
  };
  const gitStateForPathIfAvailable = async (
    path: string,
  ): Promise<GitState | null> => {
    try {
      return await gitStateForPath(path);
    } catch {
      return null;
    }
  };
  const gitContextForWorkspace = async (
    workspace: ProjectWorkspace,
  ): Promise<ProjectWorkspaceGitContext> => {
    const workspaceGitState = await gitStateForPathIfAvailable(workspace.path);
    const candidates = dedupePaths(
      gitOperationPathCandidates(workspace, workspaceGitState),
    );

    for (const candidate of candidates) {
      const candidateGitState = isSameWorkspacePath(candidate, workspace.path)
        ? workspaceGitState
        : await gitStateForPathIfAvailable(candidate);
      if (candidateGitState?.isGitRepo) {
        return {
          gitState: candidateGitState,
          operationPath: candidate,
        };
      }
    }

    throw nonGitStartupWorkspaceError(workspace);
  };

  validateStartupName(startupWorkspaces, trimmedStartupName);

  const startupModeByRepo = new Map<string, ProjectWorkspaceStartupMode>();
  const branchWorktreeByRepo = new Map<string, string>();
  const gitContextByWorkspacePath = new Map<
    string,
    ProjectWorkspaceGitContext
  >();
  for (const workspace of startupWorkspaces) {
    const gitContext = await gitContextForWorkspace(workspace);
    gitContextByWorkspacePath.set(normalizedKey(workspace.path), gitContext);
    const { gitState } = gitContext;
    if (gitState.localBranches.includes(trimmedStartupName)) {
      throw existingStartupBranchError(workspace, trimmedStartupName);
    }

    const repoKey = repositoryKeyForGitContext(gitContext);
    const existingMode = startupModeByRepo.get(repoKey);
    if (existingMode && existingMode !== workspace.startupMode) {
      throw new Error(
        "Project workspaces in the same repository must use the same startup option.",
      );
    }
    startupModeByRepo.set(repoKey, workspace.startupMode);

    if (isWorktreeStartupMode(workspace.startupMode)) {
      const targetWorktreePath = deriveStartupWorktreePath(
        gitContext,
        trimmedStartupName,
      );
      if (targetWorktreePath && (await pathExists(targetWorktreePath))) {
        throw existingStartupWorktreePathError(workspace, targetWorktreePath);
      }
    }

    if (workspace.startupMode === "branch") {
      const classification = classifyWorkspaceAttachment(
        workspace.path,
        gitState,
      );
      const worktreeKey = normalizedKey(
        classification.worktreePath ?? workspace.worktreePath ?? workspace.path,
      );
      const existingWorktreeKey = branchWorktreeByRepo.get(repoKey);
      if (existingWorktreeKey && existingWorktreeKey !== worktreeKey) {
        throw new Error(
          "Project workspaces in the same repository can create a branch only when they share a checkout.",
        );
      }
      branchWorktreeByRepo.set(repoKey, worktreeKey);
    }
  }

  try {
    for (const workspace of workspaces) {
      if (!requiresWorkspaceStartup(workspace.startupMode)) {
        attachments.push(projectWorkspaceToAttachment(workspace));
        continue;
      }

      if (!trimmedStartupName) {
        throw new Error("A branch or worktree name is required.");
      }

      const gitContext =
        gitContextByWorkspacePath.get(normalizedKey(workspace.path)) ??
        (await gitContextForWorkspace(workspace));
      const { gitState } = gitContext;

      const repoKey = repositoryKeyForGitContext(gitContext);
      const repositoryPath = repositoryPathForGitContext(gitContext);
      const baseBranch = defaultBaseBranch(gitState);
      if (isWorktreeStartupMode(workspace.startupMode)) {
        let createdWorktree = createdWorktreeByRepo.get(repoKey);
        if (!createdWorktree) {
          const newWorktree = await createWorktree(
            gitContext.operationPath,
            trimmedStartupName,
            trimmedStartupName,
            true,
            baseBranch,
          );
          createdWorktree = newWorktree;
          createdWorktreeByRepo.set(repoKey, createdWorktree);
          rollbackActions.push({
            description: `delete branch ${newWorktree.branch}`,
            run: () =>
              deleteBranch(
                repositoryPath,
                newWorktree.branch,
                false,
                baseBranch,
              ),
          });
          rollbackActions.push({
            description: `remove worktree ${newWorktree.path}`,
            run: () => removeWorktree(repositoryPath, newWorktree.path, false),
          });
        }
        attachments.push(
          attachmentForCreatedWorktree(
            workspace,
            gitContext,
            createdWorktree,
            baseBranch,
          ),
        );
        continue;
      }

      if (!createdBranchByRepo.has(repoKey)) {
        await createBranch(
          gitContext.operationPath,
          trimmedStartupName,
          baseBranch,
        );
        createdBranchByRepo.add(repoKey);
        rollbackActions.push({
          description: `delete branch ${trimmedStartupName}`,
          run: () =>
            deleteBranch(
              gitContext.operationPath,
              trimmedStartupName,
              false,
              baseBranch,
            ),
        });
      }
      attachments.push(
        attachmentForCreatedBranch(
          workspace,
          gitContext,
          trimmedStartupName,
          baseBranch,
        ),
      );
    }
  } catch (error) {
    const rollbackErrors = await rollbackStartupMutations(rollbackActions);
    if (rollbackErrors.length > 0) {
      throw new Error(
        `${errorMessage(error)} Rollback also failed: ${rollbackErrors.join("; ")}`,
      );
    }
    throw friendlyWorkspaceSetupError(error);
  }

  return {
    workingDir: attachments[0]?.path ?? project.workingDirs[0],
    workspaceAttachments: attachments,
  };
}
