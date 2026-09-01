import { isSameWorkspacePath } from "@/features/chat/lib/workspaceAttachments";
import { checkDirectoriesExist, resolvePath } from "@/shared/api/pathResolver";

import { CommandError } from "../types";

/**
 * Resolve `path` (expanding `~`) and confirm it is an existing directory.
 *
 * Strict by design: an inconclusive probe throws instead of passing, unlike
 * missingProjectDirs' checkDirectory, whose "treat unknown as present" rule
 * exists for best-effort recovery paths. Commands that promise "the
 * directory must already exist" must not persist a cwd they could not
 * verify.
 */
export async function resolveExistingDirectoryOrThrow(
  path: string,
): Promise<string> {
  let resolvedPath: string;
  let missing: string[];
  try {
    resolvedPath = (await resolvePath({ parts: [path] })).path;
    missing = await checkDirectoriesExist([resolvedPath]);
  } catch (error) {
    throw new CommandError(
      "internal_error",
      `Could not verify "${path}" is an existing directory (${String(error)}); nothing was changed. Check the path and retry.`,
    );
  }
  if (missing.length > 0) {
    throw new CommandError(
      "invalid_args",
      `No directory at "${path}"; pass an existing worktree or folder path.`,
    );
  }
  return resolvedPath;
}

export async function assertExistingDirectory(
  resolvedPath: string,
): Promise<void> {
  let missing: string[];
  try {
    missing = await checkDirectoriesExist([resolvedPath]);
  } catch (error) {
    throw new CommandError(
      "internal_error",
      `Could not verify "${resolvedPath}" is an existing directory (${String(error)}); nothing was changed. Check the path and retry.`,
    );
  }
  if (missing.length > 0) {
    throw new CommandError(
      "invalid_args",
      `No directory at "${resolvedPath}"; pass an existing worktree or folder path.`,
    );
  }
}

export async function workspaceMatchesPath(
  storedPath: string,
  resolvedPath: string,
): Promise<boolean> {
  if (isSameWorkspacePath(storedPath, resolvedPath)) {
    return true;
  }
  try {
    const expanded = (await resolvePath({ parts: [storedPath] })).path;
    return isSameWorkspacePath(expanded, resolvedPath);
  } catch {
    return false;
  }
}

export async function findMatchingWorkspace<
  TWorkspace extends { path: string },
>(
  workspaces: TWorkspace[],
  resolvedPath: string,
): Promise<TWorkspace | undefined> {
  for (const workspace of workspaces) {
    if (await workspaceMatchesPath(workspace.path, resolvedPath)) {
      return workspace;
    }
  }
  return undefined;
}

export function isAbsoluteOrHomePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("~/") ||
    path === "~" ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\\\") ||
    path.startsWith("~\\")
  );
}
