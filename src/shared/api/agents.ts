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
import { resolveAgentProviderCatalogIdStrict } from "@/features/providers/providerCatalog";
import {
  isPersonaMarkdownImportFileName,
  isSupportedPersonaImportFileName,
} from "@/shared/lib/personaImportFileName";

const AGENT_SOURCE_TYPE = "agent" as const;
const AGENT_DESCRIPTION = "Agent";
// Keep this string literal in sync with PLACEHOLDER_AGENT_DESCRIPTION in
// @/features/agents/lib/agentBuilderIdentity.ts. Defined locally, not
// imported, since that module re-exports the functions below and importing
// its value in the other direction would create a real circular import
// (unlike the type-only import that module has on this one).
const DRAFT_AGENT_DESCRIPTION = "Draft";
const PLACEHOLDER_AGENT_DESCRIPTIONS = new Set(
  [AGENT_DESCRIPTION, DRAFT_AGENT_DESCRIPTION].map((value) =>
    value.toLowerCase(),
  ),
);
const PERSONA_MD_EXTENSION = ".persona.md";
const PORTABLE_SPROUT_FRONTMATTER_KEYS = new Set([
  "name",
  "display_name",
  "description",
  "model",
  "avatar",
  "good_for",
  "vibes",
]);

// The API layer requires a non-empty description on every source, so a
// persona with no real, user-authored description still gets a placeholder
// string under the hood: "Agent" (the old default, before a description
// field existed in the create/edit form) or "Draft" (a builder draft in
// progress). Neither was written by the user on purpose, so treat both as
// "no real description" everywhere a persona's description is read back and
// shown, exported, or used as a fallback for a newer write.
export function isPlaceholderAgentDescription(
  description: string | undefined | null,
): boolean {
  const trimmed = description?.trim().toLowerCase();
  return !trimmed || PLACEHOLDER_AGENT_DESCRIPTIONS.has(trimmed);
}

export function hasRealAgentDescription(
  description: string | undefined | null,
): boolean {
  return !isPlaceholderAgentDescription(description);
}

export type AgentSourceProperties = {
  [key: string]: unknown;
  provider?: string | null;
  modelProviderId?: string | null;
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

function trimmedPropertyString(value: unknown): string | undefined {
  return propertyToString(value)?.trim() || undefined;
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
  // Direct creation paths produce finished agents, never builder drafts.
  const properties: AgentSourceProperties = { draft: false };
  if (request.provider) properties.provider = request.provider;
  if (request.modelProviderId) {
    properties.modelProviderId = request.modelProviderId;
  }
  if (request.model) properties.model = request.model;

  const avatar = avatarToProperty(request.avatar);
  if (avatar) properties.avatar = avatar;

  return properties;
}

function applyOptionalProperty(
  properties: AgentSourceProperties,
  key: keyof Pick<
    AgentSourceProperties,
    "provider" | "modelProviderId" | "model" | "avatar"
  >,
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
  applyOptionalProperty(properties, "modelProviderId", request.modelProviderId);
  applyOptionalProperty(properties, "model", request.model);
  applyOptionalProperty(
    properties,
    "avatar",
    avatarToUpdateProperty(request.avatar),
  );

  return properties;
}
function isSupportedImportFile(fileName: string): boolean {
  return isSupportedPersonaImportFileName(fileName);
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
  return isPersonaMarkdownImportFileName(fileName);
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

  const harnessId = propertyToString(properties?.provider);
  const modelProviderId = propertyToString(properties?.modelProviderId);
  let provider = modelProviderId;
  if (
    !provider &&
    harnessId &&
    resolveAgentProviderCatalogIdStrict(harnessId) !== "goose"
  ) {
    provider = harnessId;
  }
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
  const description = hasRealAgentDescription(source.description)
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
    // Keep the portable .persona.md suffix required by the import parser, but
    // derive the downloaded filename from the agent's current display name.
    filename: `${slugifyPersonaName(source.name)}${PERSONA_MD_EXTENSION}`,
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

function applyPersonaModelProperty(
  properties: AgentSourceProperties,
  value: string,
): void {
  const { provider, model } = splitPersonaModel(value);
  if (provider) {
    const harnessId = resolveAgentProviderCatalogIdStrict(provider);
    applyOptionalProperty(properties, "provider", harnessId ?? "goose");
    applyOptionalProperty(
      properties,
      "modelProviderId",
      harnessId ? null : provider,
    );
  }
  applyOptionalProperty(properties, "model", model);
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
  applyOptionalProperty(
    properties,
    "modelProviderId",
    propertyToString(parsed.modelProviderId),
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
    description: hasRealAgentDescription(
      trimmedPropertyString(parsed.description),
    )
      ? (trimmedPropertyString(parsed.description) as string)
      : AGENT_DESCRIPTION,
    content: parsed.systemPrompt as string,
    target: { scope: "global" } as const,
    properties: legacyPersonaProperties(parsed),
  };
}

function sanitizedNativeAgentImport(parsed: Record<string, unknown>): {
  data: string;
  avatar?: string;
} {
  const sanitized = { ...parsed };
  const properties = propertyToRecord(parsed.properties);
  const metadata = propertyToRecord(parsed.metadata);
  const sanitizedProperties: AgentSourceProperties = properties
    ? { ...properties }
    : {};
  const sanitizedMetadata = metadata ? { ...metadata } : undefined;
  const metadataFrontmatter = propertyToRecord(metadata?.frontmatter);
  for (const key of ["good_for", "vibes"] as const) {
    delete sanitizedProperties[key];
    if (metadataFrontmatter) delete metadataFrontmatter[key];
  }
  if (sanitizedMetadata && metadataFrontmatter) {
    if (hasEntries(metadataFrontmatter)) {
      sanitizedMetadata.frontmatter = metadataFrontmatter;
    } else {
      delete sanitizedMetadata.frontmatter;
    }
  }
  const avatar =
    legacyAvatarToProperty(properties?.avatar) ??
    legacyAvatarToProperty(metadata?.avatar) ??
    legacyAvatarToProperty(parsed.avatar);

  if ("avatar" in sanitized) {
    delete sanitized.avatar;
  }
  if ("avatar" in sanitizedProperties) {
    delete sanitizedProperties.avatar;
  }
  if (sanitizedMetadata && "avatar" in sanitizedMetadata) {
    delete sanitizedMetadata.avatar;
  }
  if (avatar) {
    sanitizedProperties.avatar = avatar;
  }

  if (hasEntries(sanitizedProperties)) {
    sanitized.properties = sanitizedProperties;
  } else {
    delete sanitized.properties;
  }
  if (sanitizedMetadata) {
    sanitized.metadata = sanitizedMetadata;
  }

  return {
    data: JSON.stringify(sanitized),
    avatar,
  };
}

function personaMarkdownProperties(
  parsed: Record<string, unknown>,
): AgentSourceProperties {
  const properties: AgentSourceProperties = {};
  const model = propertyToString(parsed.model);
  if (model) {
    applyPersonaModelProperty(properties, model);
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
    applyPersonaModelProperty(properties, model);
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

export function agentSourceToPersona(source: AgentSourceEntry): Persona {
  const writable = source.writable === true;
  return {
    id: source.path,
    displayName: source.name,
    avatar: propertyToAvatar(source.properties?.avatar),
    systemPrompt: source.content,
    provider: propertyToString(source.properties?.provider),
    modelProviderId: propertyToString(source.properties?.modelProviderId),
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
  const sources = response.sources.filter(isAgentSource);
  return Promise.all(sources.map(hydrateListedAgentSource));
}

function canHydrateListedAgentSource(source: AgentSourceEntry): boolean {
  return (
    source.writable === true &&
    source.path.length > 0 &&
    // Skip built-in/synthetic source paths such as `builtin://...`.
    !source.path.includes("://") &&
    source.path.toLowerCase().endsWith(".md") &&
    source.name === fileStem(source.path)
  );
}

async function hydrateListedAgentSource(
  source: AgentSourceEntry,
): Promise<AgentSourceEntry> {
  if (!canHydrateListedAgentSource(source)) {
    return source;
  }

  try {
    return await readAgentSourceFile(source.path, source);
  } catch {
    return source;
  }
}

function requireAgentSource(source: SourceEntry): AgentSourceEntry {
  if (!isAgentSource(source)) {
    throw new Error(`Unexpected source type returned: ${source.type}`);
  }

  return source;
}

async function preserveImportedAvatar(
  source: AgentSourceEntry,
  avatar: string | undefined,
): Promise<AgentSourceEntry> {
  if (!avatar || normalizeAvatarUrl(source.properties?.avatar) === avatar) {
    return source;
  }

  const properties = {
    ...(source.properties ?? {}),
    avatar,
  };

  try {
    const client = await getClient();
    const response = await client.goose.GooseUnstableSourcesUpdate({
      type: AGENT_SOURCE_TYPE,
      path: source.path,
      name: source.name,
      description: source.description,
      content: source.content,
      properties,
    });

    return requireAgentSource(response.source);
  } catch (error) {
    console.warn("Failed to preserve imported agent avatar:", error);
    return {
      ...source,
      properties,
    };
  }
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
  const promotedProperties = {
    ...(existing.properties ?? {}),
    ...(patch.properties ?? {}),
  };
  delete promotedProperties.draft;
  delete promotedProperties.builderSessionId;

  const client = await getClient();
  const response = await client.goose.GooseUnstableSourcesCreate({
    type: AGENT_SOURCE_TYPE,
    name,
    description: patch.description ?? existing.description,
    content: patch.content ?? existing.content,
    target: { scope: "global" },
    properties: promotedProperties,
  });
  const promoted = requireAgentSource(response.source);

  if (promoted.path !== path) {
    try {
      await client.goose.GooseUnstableSourcesDelete({
        type: AGENT_SOURCE_TYPE,
        path,
      });
    } catch (error) {
      console.warn("Failed to delete promoted agent draft:", error);
    }
  }

  return promoted;
}

export async function listPersonas(): Promise<Persona[]> {
  return (await listAgentSources())
    .filter((source) => source.properties?.draft !== true)
    .map(agentSourceToPersona);
}

export async function createPersona(
  request: CreatePersonaRequest,
): Promise<Persona> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableSourcesCreate({
    type: AGENT_SOURCE_TYPE,
    name: request.displayName,
    description: hasRealAgentDescription(request.description)
      ? (request.description as string).trim()
      : AGENT_DESCRIPTION,
    content: request.systemPrompt,
    target: { scope: "global" },
    properties: personaProperties(request),
  });

  if (!isAgentSource(response.source)) {
    throw new Error(`Unexpected source type returned: ${response.source.type}`);
  }

  const avatar = avatarToProperty(request.avatar);
  return agentSourceToPersona(
    avatar && normalizeAvatarUrl(response.source.properties?.avatar) !== avatar
      ? {
          ...response.source,
          properties: { ...(response.source.properties ?? {}), avatar },
        }
      : response.source,
  );
}

export async function updatePersona(
  persona: Persona,
  request: UpdatePersonaRequest,
): Promise<Persona> {
  const client = await getClient();
  // A description explicitly passed in this request wins, even if it's an
  // empty string (clearing the field is a real, intentional edit — same
  // as create, an empty/placeholder value falls back rather than being
  // written through literally). Otherwise, keep whatever the persona
  // already had, falling back only if that was never real to begin with.
  const description =
    request.description !== undefined
      ? hasRealAgentDescription(request.description)
        ? request.description.trim()
        : AGENT_DESCRIPTION
      : hasRealAgentDescription(persona.sourceDescription)
        ? (persona.sourceDescription as string).trim()
        : AGENT_DESCRIPTION;

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

  return agentSourceToPersona(response.source);
}

export async function migratePersonaTargetIfUnchanged(
  persona: Pick<Persona, "id" | "provider" | "modelProviderId" | "model">,
  target: Pick<UpdatePersonaRequest, "provider" | "modelProviderId" | "model">,
): Promise<Persona | null> {
  const latestSource = await readExistingPersonaSource(persona.id);
  const latestPersona = agentSourceToPersona(latestSource);
  if (
    latestPersona.provider !== persona.provider ||
    latestPersona.modelProviderId !== persona.modelProviderId ||
    latestPersona.model !== persona.model
  ) {
    return null;
  }

  const client = await getClient();
  const response = await client.goose.GooseUnstableSourcesUpdate({
    type: AGENT_SOURCE_TYPE,
    path: latestSource.path,
    name: latestSource.name,
    description: latestSource.description,
    content: latestSource.content,
    properties: mergedPersonaProperties(latestSource.properties, target),
  });

  return agentSourceToPersona(requireAgentSource(response.source));
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

export async function repairBundledAgent(fileName: string): Promise<void> {
  await invoke("repair_bundled_agent", { fileName });
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

export interface PersonaImportPreview {
  displayName: string;
  description?: string;
  systemPrompt: string;
  /** Only local/data-backed media is safe to render before import consent. */
  avatar?: string;
  identity: string;
}

function previewDescription(description: unknown): string | undefined {
  const authored = trimmedPropertyString(description);
  return hasRealAgentDescription(authored) ? authored : undefined;
}

function previewSafeAvatar(
  avatar: string | null | undefined,
): string | undefined {
  const normalized = normalizeAvatarUrl(avatar);
  return normalized?.startsWith("data:image/png;base64,") ||
    normalized?.startsWith("app-avatar:") ||
    normalized?.startsWith("user-avatar:")
    ? normalized
    : undefined;
}

export function previewPersonaImport(
  fileContents: string,
  fileName: string,
): PersonaImportPreview {
  if (!isSupportedImportFile(fileName)) {
    throw new Error("File must have a .persona.md or .json extension");
  }

  if (isPersonaMarkdownFile(fileName)) {
    const request = personaMarkdownToCreateRequest(fileContents);
    return {
      displayName: request.name,
      description: previewDescription(request.description),
      systemPrompt: request.content,
      avatar: previewSafeAvatar(request.properties.avatar),
      identity: fileName,
    };
  }

  const parsed = readImportJson(fileContents);
  if (parsed.type === AGENT_SOURCE_TYPE) {
    const properties = propertyToRecord(parsed.properties);
    const metadata = propertyToRecord(parsed.metadata);
    const displayName =
      propertyToString(parsed.name)?.trim() ??
      propertyToString(metadata?.name)?.trim();
    const systemPrompt =
      propertyToString(parsed.content)?.trim() ??
      propertyToString(parsed.instructions)?.trim();
    if (!displayName || !systemPrompt) {
      throw new Error("Agent JSON must include a name and instructions");
    }
    return {
      displayName,
      description: previewDescription(
        parsed.description ?? metadata?.description,
      ),
      systemPrompt,
      avatar: previewSafeAvatar(
        legacyAvatarToProperty(properties?.avatar) ??
          legacyAvatarToProperty(metadata?.avatar),
      ),
      identity: fileName,
    };
  }

  validateLegacyPersonaImport(parsed);
  const displayName = parsed.displayName as string;
  return {
    displayName,
    description: previewDescription(parsed.description),
    systemPrompt: parsed.systemPrompt as string,
    avatar: previewSafeAvatar(legacyPersonaProperties(parsed).avatar),
    identity: fileName,
  };
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
    return [agentSourceToPersona(response.source)];
  }

  const parsed = readImportJson(fileContents);

  if (parsed.type === AGENT_SOURCE_TYPE) {
    const nativeImport = sanitizedNativeAgentImport(parsed);
    const response = await client.goose.GooseUnstableSourcesImport({
      data: nativeImport.data,
      target: { scope: "global" },
    });
    const sources = await Promise.all(
      response.sources
        .filter(isAgentSource)
        .map((source) => preserveImportedAvatar(source, nativeImport.avatar)),
    );
    return sources.map(agentSourceToPersona);
  }

  const response = await client.goose.GooseUnstableSourcesCreate(
    legacyPersonaToCreateRequest(parsed),
  );
  if (!isAgentSource(response.source)) {
    throw new Error(`Unexpected source type returned: ${response.source.type}`);
  }
  return [agentSourceToPersona(response.source)];
}

export interface ImportFileReadResult {
  fileContents: string;
  fileName: string;
}

export interface ImportBinaryFileReadResult {
  fileBytes: number[];
  fileName: string;
}

export async function readImportAgentFile(
  sourcePath: string,
): Promise<ImportBinaryFileReadResult> {
  return invoke<ImportBinaryFileReadResult>("read_import_agent_file", {
    sourcePath,
  });
}

export async function readImportAgentImage(
  sourcePath: string,
): Promise<ImportBinaryFileReadResult> {
  return invoke<ImportBinaryFileReadResult>("read_import_agent_image", {
    sourcePath,
  });
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
