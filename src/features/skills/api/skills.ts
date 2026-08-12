import type { SourceEntry } from "@aaif/goose-sdk";
import { invoke } from "@tauri-apps/api/core";
import { getSkillProviderCapabilities } from "@/features/chat/lib/skillProviderCapabilities";
import { getClient } from "@/shared/api/acpConnection";
import { shareInFlight } from "@/shared/lib/shareInFlight";
import { isHexColor } from "@/features/projects/lib/customPillColor";
import { isPillTone } from "@/features/projects/lib/pillTones";
import {
  basename,
  deriveProjectRoot,
  getSkillFileLocation,
  normalizePath,
} from "../lib/skillsPath";
import { emitSkillsChanged } from "../lib/skillsEvents";

const SKILL_SOURCE_TYPE = "skill" as const;
const BUILTIN_SKILL_SOURCE_TYPE = "builtinSkill" as const;

export interface SkillProjectLink {
  id: string;
  name: string;
  workingDir: string;
  path: string;
  fileLocation: string;
}

export type SkillSourceKind = "app" | "global" | "project" | "builtin";

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  instructions: string;
  path: string;
  fileLocation: string;
  sourceKind: SkillSourceKind;
  sourceLabel: string;
  projectLinks: SkillProjectLink[];
  readonly: boolean;
  /** All historical pin ids this skill's current name should still resolve
   *  for (a pre-#974 Personal-skill migration, and/or a rename retiring an
   *  old-named copy from more than one legacy location). Omitted or empty
   *  when there's no historical pin to preserve. */
  legacyPinIds?: string[];
  /** User-chosen pill tone or custom pastel hex, persisted to frontmatter as `color`. Null for
   *  legacy skills created before the picker existed — consumers fall back
   *  to the deterministic hash-from-name tone in that case. */
  color: string | null;
}

export type EditingSkill = Pick<
  SkillInfo,
  "name" | "description" | "instructions" | "path" | "fileLocation" | "color"
>;

type FilesystemSkillSourceEntry = SourceEntry & {
  type: typeof SKILL_SOURCE_TYPE;
};
type BuiltinSkillSourceEntry = SourceEntry & {
  type: typeof BUILTIN_SKILL_SOURCE_TYPE;
};
type SkillSourceEntry = FilesystemSkillSourceEntry | BuiltinSkillSourceEntry;

interface AgentSkillEntry {
  name: string;
  description: string;
  content: string;
  path: string;
  fileLocation: string;
  sourceKind: SkillSourceKind;
  sourceLabel: string;
  legacyPinIds?: string[];
}

interface ListAgentSkillsResponse {
  skills: AgentSkillEntry[];
}

export interface ListSkillsOptions {
  providerId?: string | null;
  /** Set false when the caller already owns the Berd app-skill list (e.g. the
   *  chat controller's dedicated catalog effect) so it isn't fetched again
   *  only to be filtered out. Defaults to true. */
  includeAppSkills?: boolean;
  /** Replace the shared in-flight app-skills invoke instead of joining it, so
   *  a read triggered by a skills-changed event observes post-change data.
   *  The other discovery legs issue a new request per call and are always
   *  fresh. */
  fresh?: boolean;
}

function isFilesystemSkillSource(
  source: SourceEntry,
): source is FilesystemSkillSourceEntry {
  return source.type === SKILL_SOURCE_TYPE;
}

function isSkillSource(source: SourceEntry): source is SkillSourceEntry {
  return (
    source.type === SKILL_SOURCE_TYPE ||
    source.type === BUILTIN_SKILL_SOURCE_TYPE
  );
}

function toSkillInfo(source: SkillSourceEntry): SkillInfo {
  if (source.type === BUILTIN_SKILL_SOURCE_TYPE) {
    return {
      id: `builtin:${source.name}`,
      name: source.name,
      description: source.description,
      instructions: source.content,
      path: source.path,
      fileLocation: source.path,
      sourceKind: "builtin",
      sourceLabel: "Built in",
      projectLinks: [],
      readonly: true,
      color: readStoredColor(source.properties),
    };
  }

  const sourceKind: SkillSourceKind = source.global ? "global" : "project";
  const props = (source.properties ?? {}) as Record<string, unknown>;

  // Backend tags project-scoped skills with these when listing via
  // include_project_sources. Prefer them over path-derived values so badges
  // show the user-visible project title.
  const taggedProjectDir =
    typeof props.projectDir === "string" ? props.projectDir : null;
  const taggedProjectName =
    typeof props.projectName === "string" ? props.projectName : null;

  const projectRoot = source.global
    ? null
    : (taggedProjectDir ?? deriveProjectRoot(source.path));
  const projectName =
    taggedProjectName ?? (projectRoot ? basename(projectRoot) : "");

  const projectLinks: SkillProjectLink[] = projectRoot
    ? [
        {
          id: projectRoot,
          name: projectName || projectRoot,
          workingDir: projectRoot,
          path: source.path,
          fileLocation: getSkillFileLocation(source.path),
        },
      ]
    : [];

  return {
    id: `${sourceKind}:${source.path}`,
    name: source.name,
    description: source.description,
    instructions: source.content,
    path: source.path,
    fileLocation: getSkillFileLocation(source.path),
    sourceKind,
    sourceLabel:
      sourceKind === "global" ? "Personal" : projectName || "Project",
    projectLinks,
    readonly: props.berdBundled === true || props.gooseInternalBundled === true,
    color: readStoredColor(source.properties),
  };
}

export function isProjectSkillId(id: string): boolean {
  return id.startsWith("project:");
}

function readStoredColor(
  properties: SourceEntry["properties"] | undefined,
): string | null {
  const raw = (properties as Record<string, unknown> | undefined)?.color;
  return typeof raw === "string" && (isPillTone(raw) || isHexColor(raw))
    ? raw
    : null;
}

function readTaggedProjectDir(
  properties: SourceEntry["properties"] | undefined,
): string | null {
  const raw = (properties as Record<string, unknown> | undefined)?.projectDir;
  return typeof raw === "string" && raw.trim() ? raw : null;
}

function stripTrailingSlashes(path: string): string {
  const normalized = normalizePath(path);
  if (/^\/+$/.test(normalized)) {
    return "/";
  }
  if (/^[A-Za-z]:\/+$/.test(normalized)) {
    return `${normalized.slice(0, 2)}/`;
  }
  return normalized.replace(/\/+$/, "");
}

function canonicalizeManagedWorktreeRoot(projectRoot: string): string {
  const normalizedRoot = stripTrailingSlashes(projectRoot);
  const parts = normalizedRoot.split("/");
  if (parts.length < 2) {
    return normalizedRoot;
  }

  const parentName = parts[parts.length - 2];
  if (!parentName.endsWith("-worktrees")) {
    return normalizedRoot;
  }

  const repoName = parentName.slice(0, -"-worktrees".length);
  if (!repoName) {
    return normalizedRoot;
  }

  return [...parts.slice(0, -2), repoName].join("/");
}

function getRelativeSkillPath(sourcePath: string, projectRoot: string): string {
  const normalizedPath = normalizePath(sourcePath);
  const normalizedRoot = stripTrailingSlashes(projectRoot);
  const rootPrefix = `${normalizedRoot}/`;

  return normalizedPath.startsWith(rootPrefix)
    ? normalizedPath.slice(normalizedRoot.length)
    : basename(sourcePath);
}

function getSkillDedupeKey(source: SkillSourceEntry): string {
  if (source.type === BUILTIN_SKILL_SOURCE_TYPE) {
    return `builtin:${source.name}`;
  }

  if (source.global) {
    return `global:${source.path}`;
  }

  const projectRoot =
    deriveProjectRoot(source.path) ?? readTaggedProjectDir(source.properties);
  if (!projectRoot) {
    return `project:${source.path}`;
  }

  return [
    "project",
    canonicalizeManagedWorktreeRoot(projectRoot),
    getRelativeSkillPath(source.path, projectRoot),
    source.name,
    source.description,
    source.content,
  ].join("\0");
}

function mergeProjectLinks(
  existing: SkillInfo,
  incoming: SkillInfo,
): SkillInfo {
  if (existing.sourceKind !== "project" || incoming.sourceKind !== "project") {
    return existing;
  }

  const linksByWorkingDir = new Map(
    existing.projectLinks.map((project) => [project.workingDir, project]),
  );
  for (const project of incoming.projectLinks) {
    if (!linksByWorkingDir.has(project.workingDir)) {
      linksByWorkingDir.set(project.workingDir, project);
    }
  }

  return {
    ...existing,
    projectLinks: Array.from(linksByWorkingDir.values()),
  };
}

function uniqueProjectDirs(projectDirs: string[]) {
  return [...new Set(projectDirs.map((dir) => dir.trim()).filter(Boolean))];
}

export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

function toAgentSkillInfo(
  source: AgentSkillEntry,
  providerId: string | null | undefined,
): SkillInfo {
  const projectRoot =
    source.sourceKind === "project" ? deriveProjectRoot(source.path) : null;
  const projectName = projectRoot ? basename(projectRoot) : source.sourceLabel;

  return {
    id:
      source.sourceKind === "app"
        ? `app:${source.path}`
        : `agent:${providerId ?? "unknown"}:${source.path}`,
    name: source.name,
    description: source.description,
    instructions: source.content,
    path: source.path,
    fileLocation: source.fileLocation,
    sourceKind: source.sourceKind,
    sourceLabel:
      source.sourceKind === "project" ? projectName : source.sourceLabel,
    projectLinks: projectRoot
      ? [
          {
            id: projectRoot,
            name: projectName || projectRoot,
            workingDir: projectRoot,
            path: source.path,
            fileLocation: source.fileLocation,
          },
        ]
      : [],
    readonly: true,
    legacyPinIds: source.legacyPinIds ?? [],
    color: null,
  };
}

export interface CreateSkillOptions {
  /** Project source ID (kebab slug). When set, the skill is created under
   *  that project's first working directory. */
  projectId?: string;
}

export async function createSkill(
  name: string,
  description: string,
  instructions: string,
  color: string,
  options: CreateSkillOptions = {},
): Promise<SkillInfo> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableSourcesCreate({
    type: SKILL_SOURCE_TYPE,
    name,
    description,
    content: instructions,
    target: options.projectId
      ? { scope: "projectId", projectId: options.projectId }
      : { scope: "global" },
    properties: { color },
  });

  if (!isFilesystemSkillSource(response.source)) {
    throw new Error(`Unexpected source type returned: ${response.source.type}`);
  }

  const skill = toSkillInfo(response.source);
  emitSkillsChanged();
  return skill;
}

// Several surfaces list app skills at once when a chat mounts; those callers
// pass `{ coalesce: true }` so a same-tick burst issues one IPC call. Callers
// that must observe post-event data call plainly (the skills-layer `fresh`
// flag, threaded through by `fetchBerdAppSkills`, translates to that), so the
// shared slot is replaced instead of handing back an invoke that started
// before the change.
export const listBerdAppSkills = shareInFlight(
  async (): Promise<SkillInfo[]> => {
    if (!isDesktopRuntime()) {
      return [];
    }
    const response = await invoke<ListAgentSkillsResponse>(
      "list_berd_app_skills",
    );
    return response.skills.map((skill) => toAgentSkillInfo(skill, null));
  },
);

export async function listAgentFileSkills(
  projectDirs: string[],
  providerId: string | null | undefined,
): Promise<SkillInfo[]> {
  if (!isDesktopRuntime()) {
    return [];
  }

  const normalizedProjectDirs = uniqueProjectDirs(projectDirs);
  const response = await invoke<ListAgentSkillsResponse>("list_agent_skills", {
    request: {
      providerId,
      workspacePaths: normalizedProjectDirs,
    },
  });

  return response.skills.map((skill) => toAgentSkillInfo(skill, providerId));
}

export async function listGooseSourceSkills(
  projectDirs: string[],
): Promise<SkillInfo[]> {
  const client = await getClient();
  const fetchSources = (
    type: typeof SKILL_SOURCE_TYPE | typeof BUILTIN_SKILL_SOURCE_TYPE,
    projectDir?: string,
  ) =>
    client.goose.GooseUnstableSourcesList({
      type,
      ...(projectDir ? { projectDir } : {}),
    });

  const [globalResponse, builtinResponse] = await Promise.all([
    fetchSources(SKILL_SOURCE_TYPE),
    fetchSources(BUILTIN_SKILL_SOURCE_TYPE).catch(() => null),
  ]);
  const projectResponses = await Promise.allSettled(
    uniqueProjectDirs(projectDirs).map((projectDir) =>
      fetchSources(SKILL_SOURCE_TYPE, projectDir),
    ),
  );
  const responses = [
    { response: globalResponse, projectResponse: false },
    ...(builtinResponse
      ? [{ response: builtinResponse, projectResponse: false }]
      : []),
    ...projectResponses.flatMap((result) =>
      result.status === "fulfilled"
        ? [{ response: result.value, projectResponse: true }]
        : [],
    ),
  ];
  const seen = new Map<string, number>();
  const skills: SkillInfo[] = [];

  responses.forEach(({ response, projectResponse }) => {
    for (const source of response.sources) {
      if (!isSkillSource(source) || (projectResponse && source.global)) {
        continue;
      }

      const key = getSkillDedupeKey(source);
      const existingIndex = seen.get(key);
      if (existingIndex !== undefined) {
        skills[existingIndex] = mergeProjectLinks(
          skills[existingIndex],
          toSkillInfo(source),
        );
        continue;
      }

      seen.set(key, skills.length);
      skills.push(toSkillInfo(source));
    }
  });

  return skills;
}

export async function listSkills(
  projectDirs: string[] = [],
  options: ListSkillsOptions = {},
): Promise<SkillInfo[]> {
  const capabilities = getSkillProviderCapabilities(options.providerId);
  if (capabilities.discoveryMode === "agent-skill-files") {
    const skills = await listAgentFileSkills(projectDirs, options.providerId);
    return options.includeAppSkills === false
      ? skills.filter((skill) => skill.sourceKind !== "app")
      : skills;
  }

  const [gooseSkills, appSkills] = await Promise.all([
    listGooseSourceSkills(projectDirs),
    options.includeAppSkills === false
      ? []
      : listBerdAppSkills({ coalesce: !options.fresh }),
  ]);
  // Goose already orders project and Personal sources by its own precedence.
  // Append Berd app skills so a same-named Personal skill wins bare-name
  // activation while exact selection can still target either source by id.
  return [...gooseSkills, ...appSkills];
}

export async function deleteSkill(path: string): Promise<void> {
  const client = await getClient();
  await client.goose.GooseUnstableSourcesDelete({
    type: SKILL_SOURCE_TYPE,
    path,
  });

  emitSkillsChanged();
}

export async function updateSkill(
  path: string,
  name: string,
  description: string,
  instructions: string,
  color: string,
): Promise<SkillInfo> {
  const client = await getClient();
  // properties replaces the full bag, so only send fields skills own
  // client-side. projectDir/projectName/berdBundled and legacy
  // gooseInternalBundled are derived by the backend at list time, not
  // persisted through this path.
  const response = await client.goose.GooseUnstableSourcesUpdate({
    type: SKILL_SOURCE_TYPE,
    path,
    name,
    description,
    content: instructions,
    properties: { color },
  });

  if (!isFilesystemSkillSource(response.source)) {
    throw new Error(`Unexpected source type returned: ${response.source.type}`);
  }

  const skill = toSkillInfo(response.source);
  emitSkillsChanged();
  return skill;
}

export async function exportSkill(
  path: string,
): Promise<{ json: string; filename: string }> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableSourcesExport({
    type: SKILL_SOURCE_TYPE,
    path,
  });
  return { json: response.json, filename: response.filename };
}

export function isSkillImportFileName(fileName: string): boolean {
  const normalizedName = fileName.toLowerCase();
  return (
    normalizedName.endsWith(".skill.json") || normalizedName.endsWith(".json")
  );
}

export async function importSkills(
  fileBytes: number[],
  fileName: string,
): Promise<SkillInfo[]> {
  if (!isSkillImportFileName(fileName)) {
    throw new Error("File must have a .skill.json or .json extension");
  }

  const data = new TextDecoder().decode(new Uint8Array(fileBytes));
  const client = await getClient();
  const response = await client.goose.GooseUnstableSourcesImport({
    data,
    target: { scope: "global" },
  });

  emitSkillsChanged();

  return response.sources.filter(isFilesystemSkillSource).map(toSkillInfo);
}
