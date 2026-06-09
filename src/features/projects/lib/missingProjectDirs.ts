import type { ProjectInfo } from "../api/projects";
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
