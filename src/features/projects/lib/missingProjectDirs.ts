import type { ProjectInfo } from "../api/projects";
import { trimValue } from "./sessionCwdSelection";
import { checkDirectoriesExist, resolvePath } from "@/shared/api/pathResolver";

/**
 * Resolves every working directory configured on a project and returns the
 * subset that does not exist (or is not a directory) on disk.
 *
 * This is used to turn an opaque session-creation failure into a precise,
 * path-focused error: we only override the generic backend error when one or
 * more of the project's folders are actually missing. All `workingDirs` are
 * checked, not just the first, since a missing secondary folder is still worth
 * surfacing even though the session `cwd` only uses the first entry.
 */
export async function findMissingProjectDirs(
  project: ProjectInfo,
): Promise<string[]> {
  const dirs = (project.workingDirs ?? [])
    .map((directory) => directory?.trim())
    .filter((directory): directory is string => Boolean(directory));
  if (dirs.length === 0) {
    return [];
  }

  const resolved = await Promise.all(
    dirs.map((directory) =>
      resolvePath({ parts: [directory] }).then((result) => result.path),
    ),
  );

  return checkDirectoriesExist(resolved);
}

export interface DirectoryStatus {
  resolvedPath: string;
  missing: boolean;
}

/**
 * Resolves a single directory and reports whether it exists on disk, or null
 * for blank input. An inconclusive existence check counts as present: the
 * caller's recovery is best-effort and must not block on a failed probe.
 */
export async function checkDirectory(
  directory: string | null | undefined,
): Promise<DirectoryStatus | null> {
  const trimmed = trimValue(directory);
  if (!trimmed) {
    return null;
  }

  const resolvedPath = (await resolvePath({ parts: [trimmed] })).path;

  try {
    const missing = await checkDirectoriesExist([resolvedPath]);
    return { resolvedPath, missing: missing.length > 0 };
  } catch {
    return { resolvedPath, missing: false };
  }
}
