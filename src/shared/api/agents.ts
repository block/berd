import { invoke } from "@tauri-apps/api/core";
import type { SourceEntry, SourceScope } from "@aaif/goose-sdk";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getClient } from "@/shared/api/acpConnection";
import type {
  Persona,
  CreatePersonaRequest,
  UpdatePersonaRequest,
  Avatar,
} from "@/shared/types/agents";
import { normalizeAvatarUrl } from "@/shared/lib/avatarUrl";

const AGENT_SOURCE_TYPE = "agent" as const;
const AGENT_DESCRIPTION = "Agent";
const PERSONA_MD_EXTENSION = ".persona.md";
const PORTABLE_SPROUT_FRONTMATTER_KEYS = new Set([
  "name",
  "display_name",
  "description",
  "model",
  "avatar",
]);

export type AgentSourceProperties = {
  [key: string]: unknown;
  provider?: string | null;
  model?: string | null;
  avatar?: string | null;
  draft?: boolean;
  builderSessionId?: string;
};

export type AgentSourceEntry = SourceEntry & {
  type: typeof AGENT_SOURCE_TYPE;
  properties?: AgentSourceProperties;
};

export type CreatePersonaSourceRequest = {
  type: typeof AGENT_SOURCE_TYPE;
  name: string;
  description: string;
  content: string;
  target: SourceScope;
  properties?: AgentSourceProperties;
};

export type PersonaSourcePatch = Partial<
  Pick<AgentSourceEntry, "name" | "description" | "content" | "properties">
>;

function isAgentSource(source: SourceEntry): source is AgentSourceEntry {
  return source.type === AGENT_SOURCE_TYPE;
}

function avatarToProperty(
  avatar: Avatar | null | undefined,
): string | null | undefined {
  if (avatar === undefined) {
    return undefined;
  }
  if (avatar === null) {
    return null;
  }
  return normalizeAvatarUrl(avatar);
}

function propertyToAvatar(value: unknown): Avatar | null {
  return normalizeAvatarUrl(value) ?? null;
}

function avatarToUpdateProperty(
  avatar: Avatar | null | undefined,
): string | null | undefined {
  if (avatar === undefined) {
    return undefined;
  }

  return avatarToProperty(avatar) ?? null;
}

function propertyToString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function propertyToRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function personaProperties(
  request: CreatePersonaRequest,
): AgentSourceProperties {
  const properties: AgentSourceProperties = {};
  if (request.provider) properties.provider = request.provider;
  if (request.model) properties.model = request.model;

  const avatar = avatarToProperty(request.avatar);
  if (avatar) properties.avatar = avatar;

  return properties;
}

function applyOptionalProperty(
  properties: AgentSourceProperties,
  key: keyof Pick<AgentSourceProperties, "provider" | "model" | "avatar">,
  value: string | null | undefined,
): void {
  if (value === undefined) {
    return;
  }

  if (value === null || value.length === 0) {
    properties[key] = null;
    return;
  }

  properties[key] = value;
}

function mergedPersonaProperties(
  existing: Record<string, unknown> | undefined,
  request: UpdatePersonaRequest,
): AgentSourceProperties {
  const properties: AgentSourceProperties = { ...(existing ?? {}) };

  applyOptionalProperty(properties, "provider", request.provider);
  applyOptionalProperty(properties, "model", request.model);
  applyOptionalProperty(
    properties,
    "avatar",
    avatarToUpdateProperty(request.avatar),
  );

  return properties;
}
function isSupportedImportFile(fileName: string): boolean {
  const lowerName = fileName.toLowerCase();
  return (
    lowerName.endsWith(PERSONA_MD_EXTENSION) || lowerName.endsWith(".json")
  );
}

function legacyAvatarToProperty(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeAvatarUrl(value);
  }

  if (typeof value === "object" && value !== null && "value" in value) {
    const avatar = value as { type?: unknown; value?: unknown };
    if (avatar.type === "url") {
      return normalizeAvatarUrl(avatar.value);
    }
  }

  return undefined;
}

function isPersonaMarkdownFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(PERSONA_MD_EXTENSION);
}

function slugifyPersonaName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");

  return slug.length > 0 ? slug : "agent";
}

function fileStem(path: string): string | undefined {
  const baseName = path.split(/[\\/]/).pop();
  if (!baseName) {
    return undefined;
  }
  const lowerName = baseName.toLowerCase();
  if (lowerName.endsWith(PERSONA_MD_EXTENSION)) {
    return baseName.slice(0, -PERSONA_MD_EXTENSION.length);
  }
  return lowerName.endsWith(".md") ? baseName.slice(0, -3) : baseName;
}

function sproutNameFromProperties(
  properties: AgentSourceProperties | undefined,
): string | undefined {
  const sprout = propertyToRecord(properties?.sprout);
  return propertyToString(sprout?.name);
}

function personaExportName(source: AgentSourceEntry): string {
  return (
    sproutNameFromProperties(source.properties) ??
    fileStem(source.path) ??
    slugifyPersonaName(source.name)
  );
}

function personaModelProperty(
  properties: AgentSourceProperties | undefined,
): string | undefined {
  const model = propertyToString(properties?.model);
  if (!model) {
    return undefined;
  }

  const provider = propertyToString(properties?.provider);
  return provider ? `${provider}:${model}` : model;
}

function sproutFrontmatterFromProperties(
  properties: AgentSourceProperties | undefined,
): Record<string, unknown> {
  const sprout = propertyToRecord(properties?.sprout);
  return propertyToRecord(sprout?.frontmatter) ?? {};
}

function serializePersonaMarkdown(source: AgentSourceEntry): ExportResult {
  const properties = source.properties;
  const name = personaExportName(source);
  const description =
    source.description.trim().length > 0
      ? source.description
      : "Imported Goose agent";
  const frontmatter: Record<string, unknown> = {
    name,
    display_name: source.name,
    description,
  };

  const model = personaModelProperty(properties);
  if (model) {
    frontmatter.model = model;
  }

  const avatar = normalizeAvatarUrl(properties?.avatar);
  if (avatar) {
    frontmatter.avatar = avatar;
  }

  Object.assign(
    frontmatter,
    unsupportedSproutFrontmatter(sproutFrontmatterFromProperties(properties)),
  );

  return {
    contents: [
      "---",
      stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd(),
      "---",
      "",
      source.content.trimEnd(),
      "",
    ].join("\n"),
    filename: `${slugifyPersonaName(name)}${PERSONA_MD_EXTENSION}`,
    mimeType: "text/markdown",
  };
}

function splitPersonaMarkdown(raw: string): {
  frontmatter: string;
  body: string;
} {
  const normalized = raw.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new Error("Invalid persona markdown: missing frontmatter");
  }

  const endIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  );
  if (endIndex === -1) {
    throw new Error("Invalid persona markdown: missing closing frontmatter");
  }

  return {
    frontmatter: lines.slice(1, endIndex).join("\n"),
    body: lines
      .slice(endIndex + 1)
      .join("\n")
      .trim(),
  };
}

function parsePersonaFrontmatter(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid persona markdown frontmatter: ${message}`);
  }

  const frontmatter = propertyToRecord(parsed);
  if (!frontmatter) {
    throw new Error("Invalid persona markdown frontmatter: expected a map");
  }
  return frontmatter;
}

function requiredFrontmatterString(
  frontmatter: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = propertyToString(frontmatter[key])?.trim();
  return value || undefined;
}

function splitPersonaModel(model: string): {
  provider?: string;
  model: string;
} {
  const separatorIndex = model.indexOf(":");
  if (separatorIndex === -1) {
    return { model };
  }

  const provider = model.slice(0, separatorIndex).trim();
  const modelId = model.slice(separatorIndex + 1).trim();
  return provider ? { provider, model: modelId } : { model: modelId };
}

function unsupportedSproutFrontmatter(
  frontmatter: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(frontmatter).filter(
      ([key]) => !PORTABLE_SPROUT_FRONTMATTER_KEYS.has(key),
    ),
  );
}

function hasEntries(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

function readImportJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid persona JSON: ${message}`);
  }
}

function validateLegacyPersonaImport(parsed: Record<string, unknown>): void {
  if (parsed.version !== 1) {
    throw new Error(
      `Unsupported persona format version ${String(parsed.version)}. Expected version 1.`,
    );
  }

  if (typeof parsed.displayName !== "string" || !parsed.displayName.trim()) {
    throw new Error("Persona displayName cannot be empty");
  }

  if (typeof parsed.systemPrompt !== "string" || !parsed.systemPrompt.trim()) {
    throw new Error("Persona systemPrompt cannot be empty");
  }
}

function legacyPersonaProperties(
  parsed: Record<string, unknown>,
): AgentSourceProperties {
  const properties: AgentSourceProperties = {};
  applyOptionalProperty(
    properties,
    "provider",
    propertyToString(parsed.provider),
  );
  applyOptionalProperty(properties, "model", propertyToString(parsed.model));
  applyOptionalProperty(
    properties,
    "avatar",
    legacyAvatarToProperty(parsed.avatar) ??
      legacyAvatarToProperty(parsed.avatarUrl),
  );
  return properties;
}

function legacyPersonaToCreateRequest(parsed: Record<string, unknown>) {
  validateLegacyPersonaImport(parsed);

  return {
    type: AGENT_SOURCE_TYPE,
    name: parsed.displayName as string,
    description: AGENT_DESCRIPTION,
    content: parsed.systemPrompt as string,
    target: { scope: "global" } as const,
    properties: legacyPersonaProperties(parsed),
  };
}

function personaMarkdownProperties(
  parsed: Record<string, unknown>,
): AgentSourceProperties {
  const properties: AgentSourceProperties = {};
  const model = propertyToString(parsed.model);
  if (model) {
    const split = splitPersonaModel(model);
    applyOptionalProperty(properties, "provider", split.provider);
    applyOptionalProperty(properties, "model", split.model);
  }
  applyOptionalProperty(
    properties,
    "avatar",
    legacyAvatarToProperty(parsed.avatar),
  );

  const sprout: Record<string, unknown> = {};
  const sproutName = propertyToString(parsed.name);
  if (sproutName) {
    sprout.name = sproutName;
  }
  const unsupported = unsupportedSproutFrontmatter(parsed);
  if (hasEntries(unsupported)) {
    sprout.frontmatter = unsupported;
  }
  if (hasEntries(sprout)) {
    properties.sprout = sprout;
  }

  return properties;
}

function personaMarkdownToCreateRequest(fileContents: string) {
  const { frontmatter, body } = splitPersonaMarkdown(fileContents);
  const parsed = parsePersonaFrontmatter(frontmatter);
  const displayName =
    requiredFrontmatterString(parsed, "display_name") ??
    requiredFrontmatterString(parsed, "name");

  if (!displayName) {
    throw new Error("Persona display_name cannot be empty");
  }
  if (!body) {
    throw new Error("Persona markdown body cannot be empty");
  }

  return {
    type: AGENT_SOURCE_TYPE,
    name: displayName,
    description:
      requiredFrontmatterString(parsed, "description") ?? AGENT_DESCRIPTION,
    content: body,
    target: { scope: "global" } as const,
    properties: personaMarkdownProperties(parsed),
  };
}

function agentSourceFromMarkdownFile(
  fileContents: string,
  sourcePath: string,
  fallback?: AgentSourceEntry,
): AgentSourceEntry {
  const { frontmatter, body } = splitPersonaMarkdown(fileContents);
  const parsed = parsePersonaFrontmatter(frontmatter);
  const displayName =
    requiredFrontmatterString(parsed, "display_name") ??
    requiredFrontmatterString(parsed, "name") ??
    fallback?.name;

  if (!displayName) {
    throw new Error("Persona display_name cannot be empty");
  }

  const properties: AgentSourceProperties = { ...(fallback?.properties ?? {}) };
  const model = propertyToString(parsed.model);
  if (model) {
    const split = splitPersonaModel(model);
    applyOptionalProperty(properties, "provider", split.provider);
    applyOptionalProperty(properties, "model", split.model);
  }
  applyOptionalProperty(
    properties,
    "avatar",
    legacyAvatarToProperty(parsed.avatar),
  );

  for (const [key, value] of Object.entries(parsed)) {
    if (
      key === "name" ||
      key === "display_name" ||
      key === "description" ||
      key === "model" ||
      key === "avatar"
    ) {
      continue;
    }
    properties[key] = value;
  }

  return {
    type: AGENT_SOURCE_TYPE,
    path: sourcePath,
    name: displayName,
    description:
      requiredFrontmatterString(parsed, "description") ??
      fallback?.description ??
      AGENT_DESCRIPTION,
    content: body,
    global: fallback?.global ?? true,
    writable: fallback?.writable ?? true,
    properties,
  };
}

function toPersona(source: AgentSourceEntry): Persona {
  const writable = source.writable === true;
  return {
    id: source.path,
    displayName: source.name,
    avatar: propertyToAvatar(source.properties?.avatar),
    systemPrompt: source.content,
    provider: propertyToString(source.properties?.provider),
    model: propertyToString(source.properties?.model),
    isBuiltin: !writable,
    writable,
    sourceDescription: source.description,
    sourceProperties: source.properties ? { ...source.properties } : undefined,
  };
}

async function listAgentSources(): Promise<AgentSourceEntry[]> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableSourcesList({
    type: AGENT_SOURCE_TYPE,
  });
  return response.sources.filter(isAgentSource);
}

function requireAgentSource(source: SourceEntry): AgentSourceEntry {
  if (!isAgentSource(source)) {
    throw new Error(`Unexpected source type returned: ${source.type}`);
  }

  return source;
}

async function findPersonaSource(path: string): Promise<AgentSourceEntry> {
  const source = (await listPersonaSources()).find(
    (source) => source.path === path,
  );
  if (!source) {
    throw new Error(`Persona source not found: ${path}`);
  }

  return source;
}

async function readExistingPersonaSource(
  path: string,
): Promise<AgentSourceEntry> {
  try {
    return await findPersonaSource(path);
  } catch {
    return readAgentSourceFile(path);
  }
}

export async function listPersonaSources(): Promise<AgentSourceEntry[]> {
  return listAgentSources();
}

export async function createPersonaSource(
  request: CreatePersonaSourceRequest,
): Promise<AgentSourceEntry> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableSourcesCreate(request);

  return requireAgentSource(response.source);
}

export async function updatePersonaSource(
  path: string,
  patch: PersonaSourcePatch,
): Promise<AgentSourceEntry> {
  const existing = await readExistingPersonaSource(path);
  const properties = patch.properties
    ? { ...(existing.properties ?? {}), ...patch.properties }
    : existing.properties;
  const client = await getClient();
  const response = await client.goose.GooseUnstableSourcesUpdate({
    type: AGENT_SOURCE_TYPE,
    path,
    name: patch.name ?? existing.name,
    description: patch.description ?? existing.description,
    content: patch.content ?? existing.content,
    properties,
  });

  return requireAgentSource(response.source);
}

export async function deletePersonaSource(path: string): Promise<void> {
  const client = await getClient();
  await client.goose.GooseUnstableSourcesDelete({
    type: AGENT_SOURCE_TYPE,
    path,
  });
}

export async function promotePersonaSource(
  path: string,
  patch: PersonaSourcePatch,
): Promise<AgentSourceEntry> {
  const existing = await readExistingPersonaSource(path);
  const name = patch.name ?? existing.name;
  const client = await getClient();
  const response = await client.goose.GooseUnstableSourcesUpdate({
    type: AGENT_SOURCE_TYPE,
    path,
    name,
    description: patch.description ?? existing.description,
    content: patch.content ?? existing.content,
    properties: patch.properties ?? existing.properties,
  });

  const promoted = requireAgentSource(response.source);

  return promoted;
}

export async function listPersonas(): Promise<Persona[]> {
  return (await listAgentSources())
    .filter((source) => source.properties?.draft !== true)
    .map(toPersona);
}

export async function createPersona(
  request: CreatePersonaRequest,
): Promise<Persona> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableSourcesCreate({
    type: AGENT_SOURCE_TYPE,
    name: request.displayName,
    description: AGENT_DESCRIPTION,
    content: request.systemPrompt,
    target: { scope: "global" },
    properties: personaProperties(request),
  });

  if (!isAgentSource(response.source)) {
    throw new Error(`Unexpected source type returned: ${response.source.type}`);
  }

  return toPersona(response.source);
}

export async function updatePersona(
  persona: Persona,
  request: UpdatePersonaRequest,
): Promise<Persona> {
  const client = await getClient();
  const description = persona.sourceDescription ?? AGENT_DESCRIPTION;

  const response = await client.goose.GooseUnstableSourcesUpdate({
    type: AGENT_SOURCE_TYPE,
    path: persona.id,
    name: request.displayName ?? persona.displayName,
    description,
    content: request.systemPrompt ?? persona.systemPrompt,
    properties: mergedPersonaProperties(persona.sourceProperties, request),
  });

  if (!isAgentSource(response.source)) {
    throw new Error(`Unexpected source type returned: ${response.source.type}`);
  }

  return toPersona(response.source);
}

export async function deletePersona(id: string): Promise<void> {
  const client = await getClient();
  await client.goose.GooseUnstableSourcesDelete({
    type: AGENT_SOURCE_TYPE,
    path: id,
  });
}

export async function refreshPersonas(): Promise<Persona[]> {
  return listPersonas();
}

export interface ExportResult {
  contents: string;
  filename: string;
  mimeType: string;
}

export async function exportPersona(id: string): Promise<ExportResult> {
  const source = (await listAgentSources()).find(
    (source) => source.path === id,
  );
  if (!source) {
    throw new Error(`Persona ${id} not found`);
  }

  return serializePersonaMarkdown(source);
}

export async function importPersonas(
  fileContents: string,
  fileName: string,
): Promise<Persona[]> {
  if (!isSupportedImportFile(fileName)) {
    throw new Error(
      "File must have a .persona.md, .agent.json, .persona.json, or .json extension",
    );
  }

  const client = await getClient();

  if (isPersonaMarkdownFile(fileName)) {
    const response = await client.goose.GooseUnstableSourcesCreate(
      personaMarkdownToCreateRequest(fileContents),
    );
    if (!isAgentSource(response.source)) {
      throw new Error(
        `Unexpected source type returned: ${response.source.type}`,
      );
    }
    return [toPersona(response.source)];
  }

  const parsed = readImportJson(fileContents);

  if (parsed.type === AGENT_SOURCE_TYPE) {
    const response = await client.goose.GooseUnstableSourcesImport({
      data: fileContents,
      target: { scope: "global" },
    });
    return response.sources.filter(isAgentSource).map(toPersona);
  }

  const response = await client.goose.GooseUnstableSourcesCreate(
    legacyPersonaToCreateRequest(parsed),
  );
  if (!isAgentSource(response.source)) {
    throw new Error(`Unexpected source type returned: ${response.source.type}`);
  }
  return [toPersona(response.source)];
}

export interface ImportFileReadResult {
  fileContents: string;
  fileName: string;
}

export async function readImportPersonaFile(
  sourcePath: string,
): Promise<ImportFileReadResult> {
  return invoke<ImportFileReadResult>("read_import_persona_file", {
    sourcePath,
  });
}

export async function readAgentSourceFile(
  sourcePath: string,
  fallback?: AgentSourceEntry,
): Promise<AgentSourceEntry> {
  const result = await invoke<ImportFileReadResult>("read_agent_source_file", {
    sourcePath,
  });
  return agentSourceFromMarkdownFile(result.fileContents, sourcePath, fallback);
}
