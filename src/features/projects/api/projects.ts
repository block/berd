import { invoke } from "@tauri-apps/api/core";
import { getClient } from "@/shared/api/acpConnection";
import {
  createProjectArtifactMetadata,
  parseProjectArtifactMetadata,
} from "../artifact/deriveProjectArtifactState";
import type {
  WorkspaceAttachment,
  WorkspaceAttachmentKind,
  WorkspaceAttachmentSource,
} from "@/shared/types/chat";
import {
  normalizeWorkspacePath,
  workspaceAttachmentIdForPath,
} from "@/features/chat/lib/workspaceAttachments";
import { toIdentityKey } from "@/shared/lib/pathIdentity";
import type { ProjectArtifactMetadata } from "../artifact/types";

export type ProjectWorkspaceStartupMode =
  | "none"
  | "branch"
  | "worktree"
  | "ask-worktree"
  | "auto-worktree";

export function isWorktreeStartupMode(
  mode: ProjectWorkspaceStartupMode,
): boolean {
  return mode === "worktree" || mode === "auto-worktree";
}

export function isAskWorktreeStartupMode(
  mode: ProjectWorkspaceStartupMode,
): boolean {
  return mode === "worktree" || mode === "auto-worktree";
}

export function requiresWorkspaceStartup(
  mode: ProjectWorkspaceStartupMode,
): boolean {
  return mode === "branch" || isWorktreeStartupMode(mode);
}

export interface ProjectWorkspace extends WorkspaceAttachment {
  startupMode: ProjectWorkspaceStartupMode;
}

export interface ProjectInfo {
  id: string;
  /** Stable on-disk path of the project source. Pass back to update/delete. */
  path: string;
  name: string;
  description: string;
  prompt: string;
  icon: string;
  color: string;
  projectWorkspaces: ProjectWorkspace[];
  workingDirs: string[];
  useWorktrees: boolean;
  order: number;
  archivedAt: string | null;
  artifact?: ProjectArtifactMetadata | null;
  chatGroups?: ProjectChatGroupsMetadata | null;
}

export interface ProjectChatGroupMetadata {
  id: string;
  name: string;
  chatIds: string[];
}

export interface ProjectChatGroupsMetadata {
  groups: ProjectChatGroupMetadata[];
}

function createArtifactMetadata(
  projectId: string,
  project: Pick<ProjectInfo, "name" | "prompt" | "color" | "workingDirs">,
): ProjectArtifactMetadata {
  return createProjectArtifactMetadata({
    projectId,
    name: project.name,
    prompt: project.prompt,
    color: project.color,
    workingDirs: project.workingDirs,
  });
}

function validStartupMode(value: unknown): ProjectWorkspaceStartupMode {
  if (value === "worktree") return "auto-worktree";
  if (value === "branch") return "ask-worktree";
  if (value === "ask-worktree" || value === "auto-worktree") return value;
  return "none";
}

function validWorkspaceKind(value: unknown): WorkspaceAttachmentKind {
  return value === "repository" ||
    value === "git-main-worktree" ||
    value === "git-linked-worktree" ||
    value === "git-detached-checkout" ||
    value === "subdirectory" ||
    value === "non-git-directory"
    ? value
    : "directory";
}

function validWorkspaceSource(value: unknown): WorkspaceAttachmentSource {
  return value === "selected" ||
    value === "created" ||
    value === "excluded" ||
    value === "inferred"
    ? value
    : "inferred";
}

function normalizeProjectWorkspace(value: unknown): ProjectWorkspace | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Partial<ProjectWorkspace>;
  const path = normalizeWorkspacePath(raw.path);
  if (!path) {
    return null;
  }

  const workspace: ProjectWorkspace = {
    id: raw.id || workspaceAttachmentIdForPath(path),
    path,
    kind: validWorkspaceKind(raw.kind),
    source: validWorkspaceSource(raw.source),
    branch: typeof raw.branch === "string" ? raw.branch : null,
    usedByAgent: false,
    startupMode: validStartupMode(raw.startupMode),
  };

  if (typeof raw.repositoryPath === "string" && raw.repositoryPath.trim()) {
    workspace.repositoryPath = raw.repositoryPath.trim();
  }
  if (typeof raw.worktreePath === "string" && raw.worktreePath.trim()) {
    workspace.worktreePath = raw.worktreePath.trim();
  }

  return workspace;
}

export function projectWorkspaceFromDirectory(
  directory: string,
  startupMode: ProjectWorkspaceStartupMode = "none",
): ProjectWorkspace | null {
  const path = normalizeWorkspacePath(directory);
  if (!path) {
    return null;
  }

  return {
    id: workspaceAttachmentIdForPath(path),
    path,
    kind: "directory",
    source: "inferred",
    branch: null,
    usedByAgent: false,
    startupMode,
  };
}

function dedupeProjectWorkspaces(
  workspaces: ProjectWorkspace[],
): ProjectWorkspace[] {
  const byPath = new Map<string, ProjectWorkspace>();
  for (const workspace of workspaces) {
    const path = normalizeWorkspacePath(workspace.path);
    if (!path) {
      continue;
    }
    byPath.set(toIdentityKey(path), {
      ...workspace,
      id: workspace.id || workspaceAttachmentIdForPath(path),
      path,
      usedByAgent: false,
      startupMode: validStartupMode(workspace.startupMode),
    });
  }
  return [...byPath.values()];
}

export function normalizeProjectWorkspaces(
  workspaces: ProjectWorkspace[] | undefined,
  workingDirs: string[] = [],
  useWorktrees = false,
): ProjectWorkspace[] {
  const normalizedFromWorkspaces = (workspaces ?? [])
    .map(normalizeProjectWorkspace)
    .filter((workspace): workspace is ProjectWorkspace => workspace !== null);

  if (normalizedFromWorkspaces.length > 0) {
    return dedupeProjectWorkspaces(normalizedFromWorkspaces);
  }

  return dedupeProjectWorkspaces(
    workingDirs
      .map((directory) =>
        projectWorkspaceFromDirectory(
          directory,
          useWorktrees ? "worktree" : "none",
        ),
      )
      .filter((workspace): workspace is ProjectWorkspace => workspace !== null),
  );
}

function projectWorkspacePaths(workspaces: ProjectWorkspace[]): string[] {
  return workspaces.map((workspace) => workspace.path);
}

// Shape returned by _goose/sources/*. Narrowed to project-type sources here.
interface SourceEntry {
  type: "project";
  name: string;
  description: string;
  content: string;
  path: string;
  global: boolean;
  properties: Record<string, unknown>;
}

function toProjectInfo(source: SourceEntry): ProjectInfo {
  const p = source.properties ?? {};
  const rawWorkingDirs = (p.workingDirs as string[]) ?? [];
  const useWorktrees = (p.useWorktrees as boolean) ?? false;
  const projectWorkspaces = normalizeProjectWorkspaces(
    p.projectWorkspaces as ProjectWorkspace[] | undefined,
    rawWorkingDirs,
    useWorktrees,
  );
  return {
    id: source.name,
    path: source.path,
    name: (p.title as string) ?? source.name,
    description: source.description,
    prompt: source.content,
    icon: (p.icon as string) ?? "",
    color: (p.color as string) ?? "",
    projectWorkspaces,
    workingDirs: projectWorkspacePaths(projectWorkspaces),
    useWorktrees,
    order: (p.order as number) ?? 0,
    archivedAt: (p.archivedAt as string) ?? null,
    artifact: parseProjectArtifactMetadata(p.artifact),
    chatGroups: parseProjectChatGroupsMetadata(p.chatGroups),
  };
}

interface ProjectMetadataFields {
  name: string;
  icon: string;
  color: string;
  projectWorkspaces: ProjectWorkspace[];
  workingDirs: string[];
  useWorktrees: boolean;
  order: number;
  archivedAt: string | null;
  artifact?: ProjectArtifactMetadata | null;
  chatGroups?: ProjectChatGroupsMetadata | null;
}

function toProperties(info: ProjectMetadataFields): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const projectWorkspaces = normalizeProjectWorkspaces(
    info.projectWorkspaces,
    info.workingDirs,
    info.useWorktrees,
  );
  const workingDirs = projectWorkspacePaths(projectWorkspaces);
  if (info.name) props.title = info.name;
  if (info.icon) props.icon = info.icon;
  if (info.color) props.color = info.color;
  if (workingDirs.length) props.workingDirs = workingDirs;
  if (projectWorkspaces.length) props.projectWorkspaces = projectWorkspaces;
  if (info.useWorktrees) props.useWorktrees = info.useWorktrees;
  if (typeof info.order === "number") props.order = info.order;
  if (info.archivedAt) props.archivedAt = info.archivedAt;
  if (info.artifact) props.artifact = info.artifact;
  if (info.chatGroups?.groups.length) props.chatGroups = info.chatGroups;
  return props;
}

function parseProjectChatGroupsMetadata(
  value: unknown,
): ProjectChatGroupsMetadata | null {
  if (!value || typeof value !== "object") return null;

  const rawGroups = (value as { groups?: unknown }).groups;
  if (!Array.isArray(rawGroups)) return null;

  const groups: ProjectChatGroupMetadata[] = [];
  for (const rawGroup of rawGroups) {
    if (!rawGroup || typeof rawGroup !== "object") continue;
    const group = rawGroup as {
      id?: unknown;
      name?: unknown;
      chatIds?: unknown;
    };
    if (typeof group.id !== "string" || typeof group.name !== "string") {
      continue;
    }

    groups.push({
      id: group.id,
      name: group.name,
      chatIds: Array.isArray(group.chatIds)
        ? group.chatIds.filter(
            (chatId): chatId is string => typeof chatId === "string",
          )
        : [],
    });
  }

  return groups.length > 0 ? { groups } : null;
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

/** Pick a slug for `name` that does not collide with any existing project ID
 *  (active or archived). Two display names that normalize to the same slug
 *  (e.g. "My App" and "my-app", or both collapsing to "project" because they
 *  contain no ASCII alphanumerics) are disambiguated with a numeric suffix. */
function uniqueProjectSlug(name: string, existingIds: Set<string>): string {
  const base = slugify(name);
  if (!existingIds.has(base)) {
    return base;
  }
  let counter = 2;
  while (existingIds.has(`${base}-${counter}`)) {
    counter += 1;
  }
  return `${base}-${counter}`;
}

export interface ProjectIconCandidate {
  id: string;
  label: string;
  icon: string;
  sourceDir: string;
}

export interface ProjectIconData {
  icon: string;
}

export async function listProjects(): Promise<ProjectInfo[]> {
  const client = await getClient();
  const raw = await client.goose.GooseUnstableSourcesList({
    type: "project",
  });
  const sources = (raw.sources ?? []) as unknown as SourceEntry[];
  return sources
    .map(toProjectInfo)
    .filter((p) => p.archivedAt === null)
    .sort((a, b) => a.order - b.order);
}

export async function scanProjectIcons(
  workingDirs: string[],
): Promise<ProjectIconCandidate[]> {
  return invoke("scan_project_icons", { workingDirs });
}

export async function readProjectIcon(path: string): Promise<ProjectIconData> {
  return invoke("read_project_icon", { path });
}

export async function createProject(
  name: string,
  description: string,
  prompt: string,
  icon: string,
  color: string,
  workingDirs: string[],
  useWorktrees: boolean,
  projectWorkspaces: ProjectWorkspace[] = normalizeProjectWorkspaces(
    undefined,
    workingDirs,
    useWorktrees,
  ),
): Promise<ProjectInfo> {
  const client = await getClient();
  const existing = await listAllProjects();
  const id = uniqueProjectSlug(name, new Set(existing.map((p) => p.id)));
  const normalizedProjectWorkspaces = normalizeProjectWorkspaces(
    projectWorkspaces,
    workingDirs,
    useWorktrees,
  );
  const normalizedWorkingDirs = projectWorkspacePaths(
    normalizedProjectWorkspaces,
  );
  const artifact = createArtifactMetadata(id, {
    name,
    prompt,
    color,
    workingDirs: normalizedWorkingDirs,
  });
  const raw = await client.goose.GooseUnstableSourcesCreate({
    type: "project",
    name: id,
    description,
    content: prompt,
    target: { scope: "global" },
    properties: toProperties({
      name,
      icon,
      color,
      projectWorkspaces: normalizedProjectWorkspaces,
      workingDirs: normalizedWorkingDirs,
      useWorktrees,
      order: 0,
      archivedAt: null,
      artifact,
      chatGroups: null,
    }),
  });
  return toProjectInfo(raw.source as SourceEntry);
}

function shouldCreateArtifactForUpdate(
  updates: Partial<Omit<ProjectInfo, "id" | "path">>,
) {
  return updates.name !== undefined || updates.color !== undefined;
}

function artifactForUpdate(
  existing: ProjectInfo,
  updates: Partial<Omit<ProjectInfo, "id" | "path">>,
  merged: ProjectInfo,
): ProjectArtifactMetadata | null {
  if ("artifact" in updates) {
    return updates.artifact ?? null;
  }

  if (existing.artifact) {
    if (updates.name !== undefined && updates.name !== existing.name) {
      return createArtifactMetadata(existing.id, merged);
    }

    return {
      ...existing.artifact,
      color:
        updates.color !== undefined
          ? createArtifactMetadata(existing.id, merged).color
          : existing.artifact.color,
    };
  }

  if (!shouldCreateArtifactForUpdate(updates)) {
    return null;
  }

  return createArtifactMetadata(existing.id, merged);
}

export async function updateProject(
  existing: ProjectInfo,
  updates: Partial<Omit<ProjectInfo, "id" | "path">>,
): Promise<ProjectInfo> {
  const merged = { ...existing, ...updates };
  const mergedProjectWorkspaces = normalizeProjectWorkspaces(
    merged.projectWorkspaces,
    merged.workingDirs,
    merged.useWorktrees,
  );
  merged.projectWorkspaces = mergedProjectWorkspaces;
  merged.workingDirs = projectWorkspacePaths(mergedProjectWorkspaces);
  const artifact = artifactForUpdate(existing, updates, merged);
  const client = await getClient();
  const raw = await client.goose.GooseUnstableSourcesUpdate({
    type: "project",
    path: existing.path,
    name: existing.id,
    description: merged.description,
    content: merged.prompt,
    properties: toProperties({
      name: merged.name,
      icon: merged.icon,
      color: merged.color,
      projectWorkspaces: merged.projectWorkspaces,
      workingDirs: merged.workingDirs,
      useWorktrees: merged.useWorktrees,
      order: merged.order,
      archivedAt: merged.archivedAt,
      artifact,
      chatGroups: merged.chatGroups,
    }),
  });
  return toProjectInfo(raw.source as SourceEntry);
}

export async function deleteProject(
  idOrProject: string | ProjectInfo,
): Promise<void> {
  const client = await getClient();
  const path =
    typeof idOrProject === "string"
      ? (await getProject(idOrProject)).path
      : idOrProject.path;
  await client.goose.GooseUnstableSourcesDelete({
    type: "project",
    path,
  });
}

export async function getProject(id: string): Promise<ProjectInfo> {
  const all = await listAllProjects();
  const match = all.find((p) => p.id === id);
  if (!match) throw new Error(`Project "${id}" not found`);
  return match;
}

/** List both archived and active projects. */
async function listAllProjects(): Promise<ProjectInfo[]> {
  const client = await getClient();
  const raw = await client.goose.GooseUnstableSourcesList({
    type: "project",
  });
  const sources = (raw.sources ?? []) as unknown as SourceEntry[];
  return sources.map(toProjectInfo);
}

export async function archiveProject(id: string): Promise<void> {
  const project = await getProject(id);
  await updateProject(project, {
    archivedAt: new Date().toISOString(),
  });
}

export async function restoreProject(id: string): Promise<void> {
  const project = await getProject(id);
  await updateProject(project, { archivedAt: null });
}

export async function reorderProjects(
  order: [string, number][],
): Promise<void> {
  const all = await listAllProjects();
  for (const [id, orderValue] of order) {
    const existing = all.find((p) => p.id === id);
    if (!existing) continue;
    await updateProject(existing, { order: orderValue });
  }
}

export async function listArchivedProjects(): Promise<ProjectInfo[]> {
  const all = await listAllProjects();
  return all.filter((p) => p.archivedAt !== null);
}
