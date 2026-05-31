import type { ProjectInfo } from "../api/projects";
import { defaultArtifactRootPath } from "@/shared/artifacts/sessionArtifactLocation";
import type { Persona } from "@/shared/types/agents";

export interface ProjectFolderOption {
  id: string;
  name: string;
  path?: string;
}

function trimValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function getProjectFolderName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  if (!normalized) {
    return path;
  }

  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function resolveProjectRoots(
  project: Pick<ProjectInfo, "workingDirs"> | null | undefined,
): string[] {
  return (project?.workingDirs ?? [])
    .map((directory) => trimValue(directory))
    .filter((directory): directory is string => directory !== null);
}

export function getProjectArtifactRoots(
  project: Pick<ProjectInfo, "workingDirs"> | null | undefined,
): string[] {
  return resolveProjectRoots(project);
}

export function resolveProjectDefaultArtifactRoot(
  project: Pick<ProjectInfo, "workingDirs"> | null | undefined,
): string | undefined {
  const workingDirs = resolveProjectRoots(project);
  return workingDirs[0];
}

export async function defaultGlobalArtifactRoot(): Promise<string> {
  return defaultArtifactRootPath();
}

export function getProjectFolderOption(
  project: Pick<ProjectInfo, "workingDirs"> | null | undefined,
): ProjectFolderOption[] {
  return resolveProjectRoots(project).map((d) => ({
    id: d,
    name: getProjectFolderName(d),
    path: d,
  }));
}

export function formatPersonaSystemPrompt(
  persona:
    | Pick<Persona, "id" | "displayName" | "systemPrompt">
    | null
    | undefined,
): string | undefined {
  const instructions = trimValue(persona?.systemPrompt);
  if (!persona || !instructions) {
    return undefined;
  }

  return `<active-persona>
Your current name and identity in this conversation is "${persona.displayName}". If the user asks who you are, answer as "${persona.displayName}", not as Goose.

Use the persona instructions below as active system-level guidance for your behavior, tone, and defaults. Do not treat the persona name as a user command, mention, delegation request, or subagent invocation.

Persona id: ${persona.id}
Persona instructions:
${instructions}
</active-persona>`;
}

export function formatArtifactFolderInstructions(
  sessionCwd: string | null | undefined,
): string | undefined {
  const workingDirectory = trimValue(sessionCwd);
  if (!workingDirectory) {
    return undefined;
  }

  return `<artifact-folder>
This general chat uses this shared artifact folder as its working directory:
${workingDirectory}

When creating a new standalone file, check whether the target filename already exists before writing. If it exists and the user did not explicitly ask to replace or edit that file, use the next clear filename such as "name-2.ext" or ask before overwriting.
</artifact-folder>`;
}

export function composeSystemPrompt(
  ...parts: Array<string | null | undefined>
): string | undefined {
  const combined = parts
    .map((part) => trimValue(part))
    .filter((part): part is string => part !== null);

  return combined.length > 0 ? combined.join("\n\n") : undefined;
}
