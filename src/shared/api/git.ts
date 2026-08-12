import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ChangedFile,
  CreatedWorktree,
  GitState,
} from "@/shared/types/git";

export const GIT_STATE_CHANGED_EVENT = "berd:git-state-changed";

export interface GitStateChangedPayload {
  operation: string;
  path: string;
  affectedPaths: string[];
  branch: string | null;
}

export function listenGitStateChanged(
  handler: (payload: GitStateChangedPayload) => void,
): Promise<UnlistenFn> {
  if (!window.__TAURI_INTERNALS__) {
    return Promise.resolve(() => {});
  }

  return listen<GitStateChangedPayload>(GIT_STATE_CHANGED_EVENT, (event) => {
    handler(event.payload);
  });
}

export async function getGitState(path: string): Promise<GitState> {
  return invoke<GitState>("get_git_state", { path });
}

export async function switchBranch(
  path: string,
  branch: string,
): Promise<void> {
  return invoke("git_switch_branch", { path, branch });
}

export async function stashChanges(path: string): Promise<void> {
  return invoke("git_stash", { path });
}

export async function initRepo(path: string): Promise<void> {
  return invoke("git_init", { path });
}

export async function fetchRepo(path: string): Promise<void> {
  return invoke("git_fetch", { path });
}

export async function pullRepo(path: string): Promise<void> {
  return invoke("git_pull", { path });
}

export async function createBranch(
  path: string,
  name: string,
  baseBranch: string,
): Promise<void> {
  return invoke("git_create_branch", { path, name, baseBranch });
}

export async function countBranchCommitsNotInBase(
  path: string,
  branch: string,
  baseBranch: string,
): Promise<number> {
  return invoke<number>("git_count_branch_commits_not_in_base", {
    path,
    branch,
    baseBranch,
  });
}

export async function hasIgnoredFiles(path: string): Promise<boolean> {
  return invoke<boolean>("git_has_ignored_files", { path });
}

export async function deleteBranch(
  path: string,
  branch: string,
  force = false,
  switchToBranch?: string,
): Promise<void> {
  return invoke("git_delete_branch", {
    path,
    branch,
    force,
    switchToBranch,
  });
}

export async function getChangedFiles(path: string): Promise<ChangedFile[]> {
  return invoke<ChangedFile[]>("get_changed_files", { path });
}

export async function createWorktree(
  path: string,
  name: string,
  branch: string,
  createBranch: boolean,
  baseBranch?: string,
): Promise<CreatedWorktree> {
  return invoke("git_create_worktree", {
    path,
    name,
    branch,
    createBranch,
    baseBranch,
  });
}

export async function removeWorktree(
  path: string,
  worktreePath: string,
  force = false,
): Promise<void> {
  return invoke("git_remove_worktree", { path, worktreePath, force });
}
