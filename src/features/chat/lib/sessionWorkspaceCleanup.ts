import {
  countBranchCommitsNotInBase,
  hasIgnoredFiles as gitHasIgnoredFiles,
  deleteBranch,
  getGitState,
  removeWorktree,
} from "@/shared/api/git";
import { acpListSessionsPage } from "@/shared/api/acp";
import { pathExists } from "@/shared/api/system";
import { acpSessionToChatSession } from "@/features/chat/lib/acpSessionMapping";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import {
  getWorkspaceAttachments,
  getWorkspaceCleanupTarget,
  isSameWorkspacePath,
  normalizeComparableWorkspacePath,
  type WorkspaceCleanupTarget,
  workspaceAttachmentUsesCleanupTarget,
} from "@/features/chat/lib/workspaceAttachments";

export interface SessionWorkspaceCleanupPlan {
  target: WorkspaceCleanupTarget;
  repositoryPath: string;
  cleanupPath: string;
}

export interface InspectedSessionWorkspaceCleanupPlan
  extends SessionWorkspaceCleanupPlan {
  uncommittedFileCount: number;
  hasIgnoredFiles: boolean;
  branchCommitsNotInBase: number;
  worktreeExists: boolean;
  branchExists: boolean;
}

export interface SessionWorkspaceCleanupResourceCounts {
  worktreeCount: number;
  branchCount: number;
}

export function getSessionWorkspaceCleanupResourceKind(
  plan: InspectedSessionWorkspaceCleanupPlan,
): "worktree" | "branch" | null {
  if (plan.target.cleanup === "worktree" && plan.worktreeExists) {
    return "worktree";
  }
  if (
    plan.target.createdBranch &&
    plan.target.branch &&
    plan.branchExists &&
    plan.branchCommitsNotInBase === 0
  ) {
    return "branch";
  }
  return null;
}

export function wouldSessionWorkspaceCleanupDiscardFiles(
  plan: InspectedSessionWorkspaceCleanupPlan,
): boolean {
  return (
    getSessionWorkspaceCleanupResourceKind(plan) !== null &&
    (plan.uncommittedFileCount > 0 || plan.hasIgnoredFiles)
  );
}

export function countSessionWorkspaceCleanupResources(
  plans: InspectedSessionWorkspaceCleanupPlan[],
): SessionWorkspaceCleanupResourceCounts {
  return plans.reduce<SessionWorkspaceCleanupResourceCounts>(
    (counts, plan) => {
      const kind = getSessionWorkspaceCleanupResourceKind(plan);
      if (kind === "worktree") counts.worktreeCount += 1;
      if (kind === "branch") counts.branchCount += 1;
      return counts;
    },
    { worktreeCount: 0, branchCount: 0 },
  );
}

const SESSION_PAGE_SAFETY_LIMIT = 10_000;

export function hasSessionWorkspaceCleanupTargets(
  session: ChatSession,
): boolean {
  return getWorkspaceAttachments(session).some(
    (attachment) =>
      attachment.source !== "excluded" &&
      getWorkspaceCleanupTarget(attachment) !== null,
  );
}

/** Loads the complete session list so a paged-out chat cannot lose a shared workspace. */
export async function loadAllSessionsForWorkspaceCleanup(): Promise<
  ChatSession[]
> {
  const sessions: ChatSession[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  do {
    const page = await acpListSessionsPage({ cursor });
    sessions.push(
      ...page.sessions.map((session) => acpSessionToChatSession(session)),
    );
    if (sessions.length > SESSION_PAGE_SAFETY_LIMIT) {
      throw new Error(
        "Session pagination exceeded the workspace cleanup limit",
      );
    }
    const nextCursor = page.nextCursor;
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor)) {
      throw new Error("Session pagination repeated during workspace cleanup");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  return sessions;
}

function cleanupTargetKey(target: WorkspaceCleanupTarget): string {
  return [
    target.cleanup,
    target.branch ?? "",
    target.repositoryPath
      ? normalizeComparableWorkspacePath(target.repositoryPath)
      : "",
    target.worktreePath
      ? normalizeComparableWorkspacePath(target.worktreePath)
      : "",
  ].join("|");
}

function isTargetUsedByAnotherActiveSession(
  target: WorkspaceCleanupTarget,
  sessionId: string,
  sessions: ChatSession[],
  homeDir: string | null,
): boolean {
  return sessions.some(
    (candidate) =>
      candidate.id !== sessionId &&
      !candidate.archivedAt &&
      getWorkspaceAttachments(candidate)
        .filter((attachment) => attachment.source !== "excluded")
        .some((attachment) =>
          workspaceAttachmentUsesCleanupTarget(attachment, target, homeDir),
        ),
  );
}

/**
 * Finds Goose-owned branches and worktrees that stop being used when a session
 * is archived. User-selected/inferred workspaces are deliberately ignored:
 * only attachments with explicit Goose lifecycle metadata are safe to delete.
 * Pass `homeDir` so used-elsewhere checks match `~`-spelled attachments
 * against absolute cleanup targets.
 */
export function planSessionWorkspaceCleanup(
  session: ChatSession,
  sessions: ChatSession[],
  homeDir: string | null = null,
): SessionWorkspaceCleanupPlan[] {
  const seenTargets = new Set<string>();
  const plans: SessionWorkspaceCleanupPlan[] = [];

  for (const attachment of getWorkspaceAttachments(session)) {
    if (attachment.source === "excluded") continue;

    const target = getWorkspaceCleanupTarget(attachment);
    if (!target) continue;

    const key = cleanupTargetKey(target);
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);

    if (
      isTargetUsedByAnotherActiveSession(target, session.id, sessions, homeDir)
    ) {
      continue;
    }

    const repositoryPath =
      target.repositoryPath ??
      attachment.repositoryPath ??
      attachment.worktreePath ??
      attachment.path;
    const cleanupPath =
      target.cleanup === "worktree"
        ? (target.worktreePath ?? attachment.worktreePath ?? attachment.path)
        : (target.worktreePath ??
          attachment.worktreePath ??
          target.repositoryPath ??
          attachment.path);

    plans.push({ target, repositoryPath, cleanupPath });
  }

  return plans;
}

async function inspectCleanupPlan(
  plan: SessionWorkspaceCleanupPlan,
): Promise<InspectedSessionWorkspaceCleanupPlan> {
  const repositoryExists = await pathExists(plan.repositoryPath);
  const cleanupPathExists = isSameWorkspacePath(
    plan.cleanupPath,
    plan.repositoryPath,
  )
    ? repositoryExists
    : await pathExists(plan.cleanupPath);

  if (!repositoryExists && !cleanupPathExists) {
    return {
      ...plan,
      uncommittedFileCount: 0,
      hasIgnoredFiles: false,
      branchCommitsNotInBase: 0,
      worktreeExists: false,
      branchExists: false,
    };
  }

  const gitState = await getGitState(
    cleanupPathExists ? plan.cleanupPath : plan.repositoryPath,
  );
  const branchExists = Boolean(
    plan.target.branch && gitState.localBranches.includes(plan.target.branch),
  );
  const uncommittedFileCount =
    plan.target.cleanup === "worktree"
      ? cleanupPathExists
        ? gitState.dirtyFileCount
        : 0
      : branchExists && gitState.currentBranch === plan.target.branch
        ? gitState.dirtyFileCount
        : 0;
  const hasIgnoredFiles =
    plan.target.cleanup === "worktree" && cleanupPathExists
      ? await gitHasIgnoredFiles(plan.cleanupPath)
      : false;
  const branchCommitsNotInBase =
    plan.target.createdBranch &&
    plan.target.branch &&
    plan.target.baseBranch &&
    branchExists
      ? await countBranchCommitsNotInBase(
          plan.repositoryPath,
          plan.target.branch,
          plan.target.baseBranch,
        ).catch((error) => {
          console.warn(
            `Could not verify whether branch "${plan.target.branch}" has commits to preserve; keeping the branch.`,
            error,
          );
          return 1;
        })
      : 0;

  return {
    ...plan,
    cleanupPath: cleanupPathExists ? plan.cleanupPath : plan.repositoryPath,
    uncommittedFileCount,
    hasIgnoredFiles,
    branchCommitsNotInBase,
    worktreeExists: plan.target.cleanup === "worktree" && cleanupPathExists,
    branchExists,
  };
}

/** Reads fresh Git state before any destructive cleanup is attempted. */
export async function inspectSessionWorkspaceCleanup(
  plans: SessionWorkspaceCleanupPlan[],
): Promise<InspectedSessionWorkspaceCleanupPlan[]> {
  return Promise.all(plans.map(inspectCleanupPlan));
}

export type SessionWorkspaceCleanupInterruptionReason =
  | "target_session_running"
  | "timed_out";

export class SessionWorkspaceCleanupInterruptedError extends Error {
  constructor(readonly reason: SessionWorkspaceCleanupInterruptionReason) {
    super(`Workspace cleanup interrupted: ${reason}`);
    this.name = "SessionWorkspaceCleanupInterruptedError";
  }
}

interface SessionWorkspaceCleanupOptions {
  getInterruptionReason?: () => SessionWorkspaceCleanupInterruptionReason | null;
}

function requireCleanupMutationAllowed(
  getInterruptionReason:
    | (() => SessionWorkspaceCleanupInterruptionReason | null)
    | undefined,
): void {
  const reason = getInterruptionReason?.();
  if (reason) {
    throw new SessionWorkspaceCleanupInterruptedError(reason);
  }
}

/**
 * Executes a previously inspected cleanup. Callers must obtain confirmation
 * before passing any plan whose uncommitted or ignored files would be lost.
 */
export async function cleanupSessionWorkspaces(
  plans: InspectedSessionWorkspaceCleanupPlan[],
  options: SessionWorkspaceCleanupOptions = {},
): Promise<void> {
  const failures: unknown[] = [];

  for (const plan of plans) {
    if (plan.target.cleanup === "worktree") {
      let removedWorktree = !plan.worktreeExists;
      if (plan.worktreeExists) {
        requireCleanupMutationAllowed(options.getInterruptionReason);
        try {
          await removeWorktree(plan.repositoryPath, plan.cleanupPath, true);
          removedWorktree = true;
        } catch (error) {
          failures.push(error);
        }
      }
      if (
        removedWorktree &&
        plan.target.createdBranch &&
        plan.target.branch &&
        plan.branchExists &&
        plan.branchCommitsNotInBase === 0
      ) {
        requireCleanupMutationAllowed(options.getInterruptionReason);
        try {
          await deleteBranch(
            plan.repositoryPath,
            plan.target.branch,
            true,
            plan.target.baseBranch ?? undefined,
          );
        } catch (error) {
          failures.push(error);
        }
      }
      continue;
    }

    if (
      plan.target.branch &&
      plan.branchExists &&
      plan.branchCommitsNotInBase === 0
    ) {
      requireCleanupMutationAllowed(options.getInterruptionReason);
      try {
        await deleteBranch(
          plan.cleanupPath,
          plan.target.branch,
          true,
          plan.target.baseBranch ?? undefined,
        );
      } catch (error) {
        failures.push(error);
      }
    }
  }

  if (failures.length > 0) {
    throw failures[0];
  }
}
