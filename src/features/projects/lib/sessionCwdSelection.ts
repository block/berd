import type { ProjectInfo } from "../api/projects";
import { resolvePath } from "@/shared/api/pathResolver";
import { resolveSessionArtifactCwd } from "@/shared/artifacts/sessionArtifactLocation";

export function trimValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function firstProjectWorkingDir(
  project: ProjectInfo | null | undefined,
): string | null {
  for (const directory of project?.workingDirs ?? []) {
    const trimmed = trimValue(directory);
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}

export type ExplicitCwdSource =
  | {
      type: "workspace" | "session";
      path: string;
    }
  | {
      type: "project";
      path: string;
      projectId: string;
    };

/**
 * Single owner of the session-cwd precedence (workspace > session working
 * dir > project working dir). Both the missing-dir preflight and the final
 * cwd resolution derive from this so they cannot disagree.
 */
export function getExplicitCwdSource(
  project: ProjectInfo | null | undefined,
  activeWorkspacePath?: string | null,
  sessionWorkingDir?: string | null,
): ExplicitCwdSource | null {
  const workspacePath = trimValue(activeWorkspacePath);
  if (workspacePath) {
    return { type: "workspace", path: workspacePath };
  }

  const trimmedSessionWorkingDir = trimValue(sessionWorkingDir);
  if (trimmedSessionWorkingDir) {
    return { type: "session", path: trimmedSessionWorkingDir };
  }

  const projectWorkingDir = firstProjectWorkingDir(project);
  if (project && projectWorkingDir) {
    return {
      type: "project",
      path: projectWorkingDir,
      projectId: project.id,
    };
  }

  return null;
}

function buildSessionCwdParts(
  project: ProjectInfo | null | undefined,
  activeWorkspacePath?: string | null,
): string[] | null {
  const source = getExplicitCwdSource(project, activeWorkspacePath);
  return source ? [source.path] : null;
}

export async function resolveSessionCwd(
  project: ProjectInfo | null | undefined,
  activeWorkspacePath?: string | null,
): Promise<string> {
  const cwdParts = buildSessionCwdParts(project, activeWorkspacePath);
  if (cwdParts) {
    return (await resolvePath({ parts: cwdParts })).path;
  }

  return resolveSessionArtifactCwd();
}
